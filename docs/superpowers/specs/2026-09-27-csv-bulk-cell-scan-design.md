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

These are preliminary measurements reported with the proposal; a reproducible harness and runtime
details are still needed. The 92 ms excludes scanning, result transfer, quote handling, trimming,
row shaping, and iterator overhead. The reported JavaScript boundary scan costs another 62 ms.
The existing delimiter kernel's 5–6 GB/s does not establish throughput for a kernel that also
counts UTF-16 units and emits three integers per cell. A roughly 3× improvement is a target,
not an established result.

The proposal considered two alternatives:

- **A `Spliterator` per row over the column delimiter** costs 2.8–3.1 µs a row against 0.33 µs for
  the string split in the reported benchmark. Per-row engine setup and iteration add work;
  rows below the WASM threshold do not call the kernel. The existing implementation retains this
  path for a column delimiter that cannot round-trip through UTF-8.
- **Byte offsets from the kernel, mapped to UTF-16 in JavaScript** need a second pass over the
  bytes to count units. Counting in the kernel avoids that pass, but its additional instructions
  still need measuring against the alternative.

## Scope

- `CSVSpliterator.from` (sync), when eligible: normalize its `CharacterSequenceInput` using the
  existing conversion semantics, including strings and byte views with nonzero offsets.
- The bulk branch of `CSVSpliterator.fromAsync`: `openDelimitedRows` already reads a sized source
  at or below `bulkThreshold` (128 KiB) whole. For an unsized stream it pulls a first chunk and
  then checks exhaustion with a second pull; the single chunk must also fit the threshold.
  Empty streams qualify too. The current helper returns row iterables, so exposing whole bytes
  requires the internal integration change described below. `bulkThreshold: 0` still forces streaming.
- The streaming branch of `fromAsync` is **out of scope**. An infinite or large stream never has
  the whole source in hand, so the question of "auto" never arises there. A sketch of how the
  design extends to it is at the end.
- `TSVSpliterator`/`PSVSpliterator` inherit through `CSVSpliterator` and need nothing.
- `XLSXSpliterator` is unrelated.

## Public surface

One option on `CSVSpliteratorInit`:

```ts
/**
 * Selects how columns are found. `"auto"` uses a bounded SIMD cell scan for eligible in-memory
 * sources and otherwise uses `"rows"`. `"rows"` decodes and splits individual rows.
 * Both paths must produce the same values. The bulk path decodes the whole source on its first
 * pull, and retained cells may retain the whole decoded string. Use `"rows"` to avoid that cost.
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
3. The row delimiter and the column delimiter are each one ASCII byte, and differ from each other and
   from the quote byte when quote handling is on. The kernel matches single bytes.
4. The SIMD scanner has loaded. `from` runs in one tick, so as today it only sees the scanner if
   the caller awaited `CharacterSequence.whenReady()` first, or something earlier in the process
   did. The bulk branch of `fromAsync` awaits it already.
5. The source decodes as valid UTF-8 under a `fatal` decoder with `ignoreBOM: true`. Invalid input throws inside the
   fast path, is caught, and the source is re-parsed by `"rows"` — whose lossy decoder produces
   U+FFFD as it does today. The `fatal` decode costs the same as the lossy one (23 ms on 40 MB,
   both reported in the preliminary measurements).
6. `position` is absent or zero. Nonzero positions use `"rows"` until byte-position semantics,
   including a position inside a UTF-8 sequence, have their own implementation and parity tests.
7. Neither delimiter is carriage return. CR as a column delimiter interacts with the row engine's
   CRLF removal before column splitting; keep that combination on `"rows"` initially.
8. The byte length and all carried relative offsets fit the signed 32-bit result representation.
   Oversized sources use `"rows"` before attempting a whole-source decode.

Condition 5 makes UTF-16 counting possible without restricting cell content to ASCII. Every valid UTF-8
sequence has a fixed unit count: 1 for an ASCII byte, 1 for a 2- or 3-byte sequence, 2 for a
4-byte sequence, 0 for a continuation byte. Only an invalid sequence breaks the count, and the
`fatal` decoder refuses those. There is no case where the fast path produces offsets that do not
match the string it slices, provided BOMs are preserved during that decode. ASCII delimiters cannot
split a UTF-8 sequence. An arbitrary single byte above `0x7F` can split one even in a valid source,
so the original one-byte condition alone would not establish parity.

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
    previous_byte: i32,       // byte before this window, or -1 at source start
    results_offset: usize,
    max_cells: usize,
) -> usize                    // number of cells written
```

The results block, `Int32Array` at `results_offset`:

| Index  | Meaning                                                                       |
| ------ | ----------------------------------------------------------------------------- |
| 0      | Byte cursor where the scan stopped, window-relative                           |
| 1      | UTF-16 units consumed up to that cursor, window-relative                      |
| 2      | `inside_quotes` at the cursor                                                 |
| 3      | UTF-16 start of the open cell at the cursor, window-relative                  |
| 4      | Whether the open cell has seen a quote                                        |
| 5 + 3n | Cell _n_ start, UTF-16 units, window-relative                                 |
| 6 + 3n | Cell _n_ end, UTF-16 units, window-relative, exclusive, `\r` excluded if crlf |
| 7 + 3n | Flags: bit 0 = the cell ends a row; bit 1 = the cell contained a quote byte   |

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
Coincident delimiters and quote bytes are excluded by the eligibility checks. The predecessor byte
is required when a row delimiter begins a window immediately after `\r`. Remove that CR only if
it belongs to the current cell; never read below `haystack_offset`. Do not strip a CR at EOF.

The kernel stops when `max_cells` cells are written or the window ends, and writes the carried
state either way. It **may stop mid-row**: the caller resumes with the same carried state and the
next batch continues the row. A row larger than a batch is therefore not special. The kernel never
reads below `haystack_offset` and never emits a cell that has not been closed; the tail after the
last delimiter is left to the caller, exactly as `scan_delimited_ranges` leaves it to `#drain`.
The returned byte cursor is immediately after the last processed byte, including the delimiter
that filled the result buffer. The unit count covers exactly that prefix. `max_cells` must be
positive, and each call over nonempty input must advance the cursor. Relative cell starts may be
negative when a cell began in an earlier window. Rebase those starts with signed arithmetic.

A window may divide a UTF-8 sequence. Count its units at the leading byte and count continuation
bytes as zero, including at the next window's start. No cell can end within that sequence because
the delimiters are ASCII. Compare `b >= 0xF0` as unsigned bytes in the SIMD implementation.

## The JavaScript side

A new module, `lib/formats/csv-cells.ts`, with one export:

```ts
export function* scanCsvCells(
  source: Uint8Array,
  text: string,            // the fatal-decoded source
  init: { rowDelimiter: number; columnDelimiter: number; quote: number; crlf: boolean; trim: boolean; skipEmpty: boolean }
): Generator<string[]>
```

It stages the source through the kernel in 64 KiB windows, the same bound the sync `Spliterator`
uses for `scanRanges` and for the same reason (the kernel copies `[cursor, end)` into WASM memory
per call, so the window keeps that copy small). Across windows it carries the byte cursor, the
absolute UTF-16 base, quote state, the open cell's start and quote flag, and the partially
assembled row. For each emitted cell it slices `text`, unquotes when bit 1 is set, trims when
asked, and pushes onto the current row; on bit 0 it yields the row and starts a new one. When the
kernel's cursor reaches the end of the source, finalize the tail using the reference engine's
semantics. With `skipEmpty: false`, an empty source yields `[""]`, and `a\n` yields `["a"]`
followed by `[""]`. With `skipEmpty: true`, those empty row ranges are omitted. A trailing column
delimiter always preserves the last empty cell. An unmatched quote keeps the remainder in the
current row. Track the row's raw extent separately from its transformed cell values.

`CharacterSequence` gains one method wrapping the export, `scanCells`, in the style of
`scanRanges`: it stages the window, calls the kernel, rebases the offsets, and returns a typed
view of the result block. Register the new export in `lib/core/wasm_module.ts` as well as the
Rust module, and regenerate the embedded binary. Everything about WASM memory stays inside
`CharacterSequence`. The wrapper aligns results to four bytes, validates allocation arithmetic,
and invalidates the cached `search()` haystack whenever it stages bytes.

The result view is valid only until another scanner call or memory growth. Copy each bounded
batch into owned storage before yielding any row or calling user code. A transformer or consumer
can run a nested CSV parse while the outer generator is suspended. It must not overwrite the
outer parser's unread cell boundaries. Carry state as JavaScript values, not borrowed views.

The row generator decides eligibility before decoding. Catch only the expected invalid-UTF-8
decode failure and then use `"rows"` over the same bytes. Do not catch header normalization,
transformer, allocation, or kernel errors and restart parsing. Those errors propagate, even before
the first yielded row; restarting could repeat user callbacks and conceal implementation faults.

Share header normalization, transformer binding, cell normalization, and emission between paths.
Preserve the existing order of operations within each entry point: synchronous parsing skips
dropped data rows before column decoding, whereas `fromAsync` currently maps rows before its
`drop` operator. Do not change callback counts or exception timing by moving that operator.
`count` and `countAsync` remain row scans and ignore `columnScan`.

### Adaptive-source integration and laziness

Add an internal optional bulk-parser callback to `openDelimitedRows` (with generic result typing),
or factor its source selection into an equivalent internal helper. The bulk branch awaits WASM
readiness and hands the complete bytes to CSV's parser; the streaming branch retains its current
row iterable. Existing Text/JSON/count callers keep the default row parser. Do not infer bulk
availability from a returned iterable or read a consumed source again.

Keep opening and decoding inside the existing deferred source thunk or generator. Constructing
a sequence performs no decode or I/O. Once bulk iteration begins, fatal validation necessarily
decodes the entire source even if only one row is requested. Measure first-row latency and early
exit separately. `fromAsync(...).take(0)` must leave the deferred source unopened; distinguish that
from the synchronous CSV `take` option, whose current implementation can read a header first.
Preserve iterator closure on early exit and header/transformer errors across the new integration.

### `skipEmpty`

The row path inherits `skipEmpty` from `Spliterator`, which drops a zero-length row range. The fast
path must match the byte range after CRLF removal, before BOM removal, unquoting, or trimming.
An empty line and a CRLF-only line are empty; `""`, a BOM-only row, whitespace, and `,,` are not.
Their emitted cells may be empty without making the source row empty.

### BOM handling

Decode with `ignoreBOM: true` so the UTF-16 offsets include every U+FEFF. The reference decoder
strips one BOM at the start of each row, not just at the start of the file. Remove exactly one
leading U+FEFF from the first raw cell of each row before unquoting and trimming. Preserve a BOM
after a column delimiter or inside quotes except where the existing `trim` behavior removes it.
For example, with `header: false, trim: false`, `\uFEFFa,b\n\uFEFFc,d` must yield
`[["a", "b"], ["c", "d"]`. Whole-source decoding with the default BOM policy would misalign
the initial offsets and preserve the second row's BOM.

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

An engine may retain the decoded parent string through sliced cells. A small retained cell can
therefore keep the whole decoded source alive after iteration and after the caller releases its
input. During parsing, bytes, decoded text, the current row, and bounded scan batches coexist.
UTF-16 content alone can require up to twice the input byte length, excluding object overhead.
This memory tradeoff is documented on `columnScan`; `"rows"` remains available to avoid whole-source
string retention. Do not depend on an engine-specific slice length threshold.

## Fallback contract

`"rows"` is the reference behavior. The fast path is correct when, for every input, it yields the
same rows in the same order with the same strings. That is a testable statement, and the parity
tests below establish parity for their covered cases. Eligibility and decode failures choose
`"rows"` before emission. Subsequent errors propagate without replaying already consumed rows.

## Testing

Use `test/formats/CSVSpliterator.test.ts`, `test/core/wasm.test.ts`, and
`test/io/adaptive-source.test.ts`. Each parity case compares both `columnScan` values. Eligible
cases await readiness and assert a call to the cell wrapper; fallback cases assert no cell scan.
Test an unavailable scanner in an isolated module/process, so another test's readiness call cannot
silently turn that test into fast-path coverage. No production counter is needed.

- **Parity over the existing fixtures**, every `mode`, with and without `header`, `trim`,
  `enableQuoteHandling`, `crlf`, `skipEmpty`.
- **Quotes**: quoted delimiters, quoted row delimiters, `""` escapes, an unmatched quote that
  runs to EOF (the `QuoteHandling.test.ts` case), padding outside quotes with `trim`.
- **CRLF**: `\r\n` rows with and without `crlf`; a lone `\r` inside a cell is data.
  Put CR at the last byte of a window and LF at the first byte of the next; preserve CR at EOF.
- **Empties**: `,,` rows, empty lines with `skipEmpty` on and off, a trailing row delimiter, a
  source with no trailing delimiter, an empty source, a single cell.
- **UTF-16 offsets**: cells containing 2-, 3- and 4-byte sequences (é, 한, 😀) before and after
  delimiters, verified against `String.prototype.split` of the decoded text.
  Split each width at every possible window boundary. Add BOMs at source start, row starts,
  inside quotes, and after column delimiters, including BOM-only rows and repeated BOMs.
- **Invalid UTF-8**: a lone `0xFF` in a cell falls back to `"rows"` and yields U+FFFD, asserted
  through the same spy.
- **Resumption**: a source over 64 KiB with a row larger than the kernel's `max_cells` batch, so
  both the window boundary and the mid-row stop are exercised.
- **Delimiter gates**: a two-byte column delimiter, and a column delimiter equal to the row
  delimiter, both take `"rows"`.
  Also cover non-ASCII bytes, quote collisions, CR delimiters, and nonzero `position`.
- **`drop`/`take`**: honored on the fast path, including `take(0)` closing without decoding
  or opening a deferred async source. Pin callback counts and errors for each entry point,
  explicit CSV options versus sequence operators, and header normalization failures.
- **Reentrancy**: interleave two parsers and run another scanner inside a transformer while a
  batch still contains unread rows. Include nested memory growth and nonzero-offset byte views.
- **Adaptive selection**: sized and single-chunk sources below, at, and above the threshold;
  empty and multi-chunk streams; `bulkThreshold: 0`; inherited TSV/PSV defaults.
- **Kernel unit tests** in `wasm.test.ts` for the raw result block: counts, flags, the carried
  state across an artificial `max_cells` of 1, and the unit counting on mixed-width input.

Commit a reproducible benchmark alongside implementation. Record fixture generation, revision,
Node version, CPU, warm-up, repetitions, and timing distribution. Compare both `columnScan`
values for array/object/entries modes, quoted and unquoted input, mixed UTF-8, trimming, small
inputs around the bulk threshold, and early exit. Measure peak memory and retained-cell memory
alongside throughput. Include batch copying and final row emission in the timed operation.
Keep the default switch contingent on parity passing and measured end-to-end benefit; investigate
material small-input or early-exit regressions before enabling it.

## Migration and risk

The proposed default is `"auto"`; output parity is an acceptance requirement, not yet a verified
result. First-pull latency and string retention change even when values match. The kernel rebuild goes
through `wasm/build.sh`, which regenerates `lib/core/wasm_base64.ts`; the toolchain
requires `cargo` and the `wasm32-unknown-unknown` target; `wasm-opt` is optional. Verify availability
when implementing rather than assuming a particular development machine.

## Out of scope, sketched: the streaming path

The async engine reads chunks into a `BufferController` and scans rows within the buffer, carrying
quote state across reads and compressions. The fast path would sit inside that loop: after each
read, decode the buffer's **complete rows** (up to the last row delimiter outside quotes) with the
`fatal` decoder, scan cells over that prefix, yield rows, then compress. Three things make it a
separate design:

1. **The scan and the decode would move into `AsyncSpliterator`**, or a sibling of it, because the
   engine today yields byte ranges and knows nothing of cells. The cell kernel replaces the row
   kernel there rather than running after it.
2. **A retained cell may retain the decoded window** it was sliced from. Small windows limit the
   amplification per retained cell, but cells retained across many windows can still keep all those
   strings alive. Any copying strategy and its allocation cost need measurement.
3. **Invalid UTF-8 mid-stream** cannot fall back by re-parsing from the start, since the source
   has been consumed. The fallback would have to be per window: re-decode that window lossily and
   split its rows the old way.

That separate design must also define incremental UTF-8 validation, BOM handling per logical row,
CRLF state, and result-buffer ownership. The bulk contract alone does not establish streaming parity.
