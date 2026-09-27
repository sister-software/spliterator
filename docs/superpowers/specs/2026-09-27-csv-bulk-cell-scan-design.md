# CSV Bulk Cell Scan — Design

**Date:** 2026-09-27
**Status:** Proposed

## Goal

Make `CSVSpliterator` several times faster over a source that is wholly in memory, with output
identical to today's path. Decode the buffer once, have the SIMD kernel emit every cell boundary
in one pass, and slice cells out of the decoded string. Today's per-row path stays, as the
fallback for everything the fast path declines.

## Why

Profiled on a 1M-row, 5-column, 40 MB CSV after the sync row scan was moved onto the bounded
kernel (commit `cacd778`), `CSVSpliterator.from` in array mode spends its time as follows:

| Share | Where                                              |
| ----- | -------------------------------------------------- |
| 51%   | `line.split(delimiter)` per row (`csv-columns.ts`) |
| 13%   | `Spliterator.next`                                 |
| 8%    | `Sequence.next`                                    |
| 8%    | `decoder.decode(row)` per row                      |

Per row that is one decode, one split, and one array. The measured floor for the alternative:

| Step                                      | Time on the same file |
| ----------------------------------------- | --------------------- |
| Current `CSVSpliterator.from`, array mode | 340 ms                |
| Decode the whole buffer once              | 23 ms                 |
| Slice every cell from the decoded string  | 69 ms                 |
| Both together                             | 92 ms                 |

The kernel's scan is not in the 92 ms. A plain JavaScript scan of the decoded string for the same
boundaries costs 62 ms; the SIMD kernel already scans delimiters at 5–6 GB/s, so its share will be
well under that. Roughly 3× is the realistic outcome.

Two alternatives were rejected on measurement:

- **A `Spliterator` per row over the column delimiter** costs 2.8–3.1 µs a row against 0.33 µs for
  the string split, because every kernel call stages bytes into WASM memory. It remains the right
  tool only for a column delimiter that cannot round-trip through UTF-8, where it already runs.
- **Byte offsets from the kernel, mapped to UTF-16 in JavaScript** needs a second pass over the
  bytes to count units. The kernel is already looking at every byte and can count for free.

## Scope

- `CSVSpliterator.from` (sync), always: the source is a whole buffer by definition.
- The bulk branch of `CSVSpliterator.fromAsync`: `openDelimitedRows` already reads a sized source
  at or below `bulkThreshold` (128 KiB) whole, and an unsized stream that is exhausted on the
  first pull. Those arrive as one `Uint8Array` and take the same path as `from`.
- The streaming branch of `fromAsync` is **out of scope**. An infinite or large stream never has
  the whole source in hand, so the question of "auto" never arises there. A sketch of how the
  design extends to it is at the end.
- `TSVSpliterator`/`PSVSpliterator` inherit through `CSVSpliterator` and need nothing.
- `XLSXSpliterator` is unrelated.

## Public surface

One option on `CSVSpliteratorInit`:

```ts
/**
 * How columns are found. `"auto"` scans every cell of a wholly in-memory source in one SIMD pass
 * and slices the decoded text, falling back to `"rows"` when it cannot. `"rows"` splits each row
 * after decoding it, as every version before 7.20 did. Output is identical either way.
 *
 * @default "auto"
 */
columnScan?: "auto" | "rows"
```

`"rows"` exists so the two paths can be compared on the same input, by the parity tests and by a
consumer who suspects a difference. Nothing else changes on the option surface. `trim`, `header`,
`mode`, `transformers`, `normalizeKeys`, `enableQuoteHandling`, `crlf`, `drop`, `take`, `skipEmpty`
and the delimiters all mean what they mean today.

## When the fast path runs

All of the following, else `"rows"`:

1. `columnScan` is `"auto"`.
2. The whole source is one `Uint8Array` (sync `from`, or the bulk branch of `fromAsync`).
3. The row delimiter and the column delimiter are each one byte, and differ from each other and
   from the quote byte when quote handling is on. The kernel matches single bytes.
4. The SIMD scanner has loaded. `from` runs in one tick, so as today it only sees the scanner if
   the caller awaited `CharacterSequence.whenReady()` first, or something earlier in the process
   did. The bulk branch of `fromAsync` awaits it already.
5. The source decodes as valid UTF-8 under a `fatal` decoder. Invalid input throws inside the
   fast path, is caught, and the source is re-parsed by `"rows"` — whose lossy decoder produces
   U+FFFD as it does today. The `fatal` decode costs the same as the lossy one (23 ms on 40 MB,
   both measured).

Condition 5 is what makes the UTF-16 offsets exact without an ASCII gate. Every valid UTF-8
sequence has a fixed unit count: 1 for an ASCII byte, 1 for a 2- or 3-byte sequence, 2 for a
4-byte sequence, 0 for a continuation byte. Only an invalid sequence breaks the count, and the
`fatal` decoder refuses those. There is no case where the fast path produces offsets that do not
match the string it slices.

## Kernel contract

One new export in `wasm/src/lib.rs`, alongside `scan_delimited_ranges`:

```rust
pub unsafe extern "C" fn scan_csv_cells(
    haystack_offset: usize,   // window start in WASM memory
    haystack_len: usize,      // window length in bytes
    row_delimiter: u32,       // one byte
    column_delimiter: u32,    // one byte
    quote: i32,               // one byte, or -1 for no quote handling
    crlf: i32,                // 1: a \r directly before the row delimiter is not part of the cell
    inside_quotes: i32,       // carried state
    cell_start_units: i32,    // carried: UTF-16 offset of the open cell, relative to the window's unit base
    cell_has_quote: i32,      // carried: whether the open cell has seen a quote
    results_offset: usize,
    max_cells: usize,
) -> usize                    // number of cells written
```

The results block, `Int32Array` at `results_offset`:

| Index         | Meaning                                                                       |
| ------------- | ----------------------------------------------------------------------------- |
| 0             | Byte cursor where the scan stopped, window-relative                           |
| 1             | UTF-16 units consumed up to that cursor, window-relative                      |
| 2             | `inside_quotes` at the cursor                                                 |
| 3             | UTF-16 start of the open cell at the cursor, window-relative                  |
| 4             | Whether the open cell has seen a quote                                        |
| 5 + 3n        | Cell _n_ start, UTF-16 units, window-relative                                 |
| 6 + 3n        | Cell _n_ end, UTF-16 units, window-relative, exclusive, `\r` excluded if crlf |
| 7 + 3n        | Flags: bit 0 = the cell ends a row; bit 1 = the cell contained a quote byte   |

The kernel walks the window 16 bytes at a time. For each vector it forms bitmasks for the row
delimiter, the column delimiter, and the quote (the existing pattern in `scan_delimited_ranges`),
and a fourth mask for **non-continuation bytes**: `(b & 0xC0) != 0x80`. The popcount of that
mask is the number of code points the vector starts; adding the popcount of `b >= 0xF0` gives
UTF-16 units. Between match positions the kernel adds those counts to a running unit total, which
is what turns a byte offset into a unit offset at each emitted boundary. The scalar tail does the
same byte by byte.

A quote toggles `inside_quotes` and sets the open cell's quote flag. A delimiter inside quotes is
data. Outside quotes a column delimiter closes the cell with bit 0 clear; a row delimiter closes it
with bit 0 set and, when `crlf` is on and the byte before the delimiter is `\r`, one unit short.
Precedence when configured bytes coincide follows `scan_delimited_ranges`: delimiter over quote.

The kernel stops when `max_cells` cells are written or the window ends, and writes the carried
state either way. It **may stop mid-row**: the caller resumes with the same carried state and the
next batch continues the row. A row larger than a batch is therefore not special. The kernel never
reads below `haystack_offset` and never emits a cell that has not been closed; the tail after the
last delimiter is left to the caller, exactly as `scan_delimited_ranges` leaves it to `#drain`.

## The JavaScript side

A new module, `lib/formats/csv-cells.ts`, with one export:

```ts
export function* scanCsvCells(
  source: Uint8Array,
  text: string,            // the fatal-decoded source
  init: { rowDelimiter: number; columnDelimiter: number; quote: number | -1; crlf: boolean; trim: boolean }
): Generator<string[]>
```

It stages the source through the kernel in 64 KiB windows, the same bound the sync `Spliterator`
uses for `scanRanges` and for the same reason (the kernel copies `[cursor, end)` into WASM memory
per call, so the window keeps that copy small). Across windows it carries the byte cursor, the
absolute UTF-16 base, quote state, the open cell's start and quote flag, and the partially
assembled row. For each emitted cell it slices `text`, unquotes when bit 1 is set, trims when
asked, and pushes onto the current row; on bit 0 it yields the row and starts a new one. When the
kernel's cursor reaches the end of the source, the tail becomes the last cell, and the last row
is yielded if it has any cell or the source did not end on a row delimiter. That last rule is what
`Spliterator.#drain` does today and is what keeps a trailing-delimiter source from growing an
empty extra row.

`CharacterSequence` gains one method wrapping the export, `scanCells`, in the style of
`scanRanges`: it stages the window, calls the kernel, rebases the offsets, and returns a typed
view of the result block. Everything about WASM memory stays inside `CharacterSequence`.

The row generator in `CSVSpliterator` (`splitRows`, and the sync branch of `fromAsync`) decides
the path at the top: conditions 1–4 are known before any decode; condition 5 is the `fatal` decode
itself, in a `try`. On success it iterates `scanCsvCells` and hands each `string[]` to the same
`emitter`/`transformers`/`drop`/`take` logic the row path uses, so `mode`, headers, and
transformers are shared code, not a second copy. On any failure before the first row is yielded
it falls back to the row path over the same bytes. A failure after the first row has been yielded
cannot happen by construction: the decode is the only thing that throws, and it runs first.

### `skipEmpty`

The row path inherits `skipEmpty` from `Spliterator`, which drops a zero-length row range. The fast
path must match: a row whose only cell is empty and which came from an empty line is dropped when
`skipEmpty` is on. A row of several empty cells (`,,`) is not empty and is kept, as today.

### Quotes

Cells with bit 1 set go through the same `unquoteColumn` the row path uses (`csv-columns.ts`),
which strips wrapping quotes and unescapes `""`. Cells without the bit skip it. The row path's
"a row without a quote cannot split differently" shortcut is the same observation, made per cell
instead of per row.

### `trim`

Applied per cell exactly as `splitRowColumns` applies it today, including the "unquote what
trimming exposed" rule for padding outside quotes, and the edge-character gate that skips the
call for clean cells. The helper moves out of `splitRowColumns` into a shared function both paths
call, so there is one definition of what trimming a cell means.

### Sliced strings

V8 represents a slice of 13 or more characters as a pointer into its parent string, so a
consumer who keeps cells alive keeps the decoded source alive. On this path the caller already
holds the source bytes, and the decoded string is at most twice their size (UTF-16), so the
retention bound is the size of the input the caller passed. This is accepted and documented on
the option. It is one of two reasons the streaming path is out of scope; there the window would
be pinned by any retained cell.

## Fallback contract

`"rows"` is the reference behavior. The fast path is correct when, for every input, it yields the
same rows in the same order with the same strings. That is a testable statement, and the parity
tests below are its enforcement. The fast path never partially succeeds: it either produces every
row or, before producing any, defers to `"rows"`.

## Testing

All in `test/formats/CSVSpliterator.test.ts` and `test/core/wasm.test.ts`, and every parity case
runs the same input through both `columnScan` values and asserts deep equality, then asserts the
fast path was the one that ran (a spy on the kernel wrapper, or a counter exposed for tests).

- **Parity over the existing fixtures**, every `mode`, with and without `header`, `trim`,
  `enableQuoteHandling`, `crlf`, `skipEmpty`.
- **Quotes**: quoted delimiters, quoted row delimiters, `""` escapes, an unmatched quote that
  runs to EOF (the `QuoteHandling.test.ts` case), padding outside quotes with `trim`.
- **CRLF**: `\r\n` rows with and without `crlf`; a lone `\r` inside a cell is data.
- **Empties**: `,,` rows, empty lines with `skipEmpty` on and off, a trailing row delimiter, a
  source with no trailing delimiter, an empty source, a single cell.
- **UTF-16 offsets**: cells containing 2-, 3- and 4-byte sequences (é, 한, 😀) before and after
  delimiters, verified against `String.prototype.split` of the decoded text.
- **Invalid UTF-8**: a lone `0xFF` in a cell falls back to `"rows"` and yields U+FFFD, asserted
  through the same spy.
- **Resumption**: a source over 64 KiB with a row larger than the kernel's `max_cells` batch, so
  both the window boundary and the mid-row stop are exercised.
- **Delimiter gates**: a two-byte column delimiter, and a column delimiter equal to the row
  delimiter, both take `"rows"`.
- **`drop`/`take`**: honored on the fast path, including `take(0)` closing without decoding
  beyond what was needed.
- **Kernel unit tests** in `wasm.test.ts` for the raw result block: counts, flags, the carried
  state across an artificial `max_cells` of 1, and the unit counting on mixed-width input.

Benchmark, recorded in AGENTS.md when landed, on the 1M-row file in the scratchpad harness: the
current 340 ms against the fast path, both modes.

## Migration and risk

No consumer change: `"auto"` is the default and output is identical. The risk is a parity gap the
tests miss, and the mitigation is the reference path one option away. The kernel rebuild goes
through `wasm/build.sh`, which regenerates `lib/core/wasm_base64.ts`; the toolchain
(`cargo`, `wasm32-unknown-unknown`, `wasm-opt`) is present on the development machine.

## Out of scope, sketched: the streaming path

The async engine reads chunks into a `BufferController` and scans rows within the buffer, carrying
quote state across reads and compressions. The fast path would sit inside that loop: after each
read, decode the buffer's **complete rows** (up to the last row delimiter outside quotes) with the
`fatal` decoder, scan cells over that prefix, yield rows, then compress. Three things make it a
separate design:

1. **The scan and the decode would move into `AsyncSpliterator`**, or a sibling of it, because the
   engine today yields byte ranges and knows nothing of cells. The cell kernel replaces the row
   kernel there rather than running after it.
2. **A retained cell pins the buffer window** it was sliced from, so the bounded-memory promise of
   streaming holds only if cells are copied out (`String` flattening) or the window is small. That
   trade needs measuring, not assuming.
3. **Invalid UTF-8 mid-stream** cannot fall back by re-parsing from the start, since the source
   has been consumed. The fallback would have to be per window: re-decode that window lossily and
   split its rows the old way.

None of those are blockers, and the kernel contract above already carries every piece of state a
window boundary needs. The sketch is here so the first cut does not close the door.
