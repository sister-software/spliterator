# CSV Bulk Cell Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse a wholly in-memory CSV by decoding it once and slicing cells at boundaries the SIMD kernel emits, with output identical to the per-row path, which stays as the fallback.

**Architecture:** A new kernel export `scan_csv_cells` walks a byte window once, tracking quote state and counting UTF-16 units, and writes `[start, end, flags]` per cell. `CharacterSequence.scanCells` stages a window and returns an owned copy of that batch. `lib/formats/csv-cells.ts` drives it across 64 KiB windows, slices a `fatal`-decoded string, and yields `string[]` rows. `CSVSpliterator` picks that path when eligible (option `columnScan: "auto"`), otherwise the existing row path; the async bulk branch reaches it through a parser callback on `openDelimitedRows`.

**Tech Stack:** TypeScript (ESM), Rust `no_std` + `wasm32` SIMD (`wasm/`), vitest, `wasm/build.sh` (cargo, `wasm32-unknown-unknown`, optional `wasm-opt`).

**Spec:** `docs/superpowers/specs/2026-09-27-csv-bulk-cell-scan-design.md`

## Global Constraints

- Node >= 20.18.1; package manager is yarn v4; always run vitest with `--run` (`yarn test --run ...` compiles first).
- Lint is `yarn lint` (prettier + eslint via oxfmt/oxlint); `yarn lint:fix` first, then `yarn lint` must print nothing.
- Every non-type import reachable from an entry point must be a real dependency; this plan adds none.
- The kernel is rebuilt only through `wasm/build.sh`, which regenerates `lib/core/wasm_base64.ts`. Commit that generated file with the Rust change.
- Output parity with `columnScan: "rows"` is the acceptance requirement for every eligible input; `"rows"` is the reference and is not modified except to share helpers.
- The fast path catches only the `fatal` decoder's `TypeError` and falls back before emitting any row. Every other error propagates.
- Construction of a `Sequence`/`AsyncSequence` performs no decode or I/O; `fromAsync(...).take(0)` leaves the deferred source unopened.
- Result views returned by the kernel alias shared WASM memory; every batch is copied into owned storage before any row is yielded.
- The kernel never reads below `haystack_offset`; a `\r` before a row delimiter that begins a window comes from `previous_byte`. A `\r` at EOF is never stripped.
- Rebase kernel offsets with signed arithmetic; a carried cell start may be negative relative to the window.
- `count`/`countAsync` remain row scans and ignore `columnScan`.
- The `"auto"` default ships only after Task 7's benchmark shows an end-to-end gain without a material small-input or early-exit regression.

## Review Focus

Inputs the spec implies but no task's tests would otherwise exercise, most likely to bite first. Each has a pinned test in the named task.

1. A quoted cell that spans two 64 KiB windows and contains the row delimiter (Task 3: "a quoted newline straddling the window").
2. A 4-byte sequence (😀) split by the window boundary, with a delimiter right after it (Task 3: "a supplementary character straddling the window").
3. A `\r\n` where `\r` is the last byte of one window and `\n` the first of the next, with `crlf` on and off (Task 3: "CRLF straddling the window").
4. A source that is exactly one row with no trailing delimiter, one cell, containing only a BOM (Task 3: "a BOM-only single-cell source").
5. `fromAsync` over an unsized single-chunk stream that is valid UTF-8 but whose header row throws in `normalizeColumnNames` consumer code (a transformer that throws), asserting the error propagates once and the source is closed (Task 6: "a throwing transformer on the bulk path propagates once").

---

### Task 1: Kernel export `scan_csv_cells`

**Files:**

- Modify: `wasm/src/lib.rs` (append after `write_range_scan_state`, ~line 302)
- Modify: `lib/core/wasm_module.ts` (types + `loadWasmModule` exports)
- Generated: `lib/core/wasm_base64.ts` via `wasm/build.sh`
- Modify: `wasm/spliterator_wasm.wasm` (build output, tracked)
- Test: `test/core/wasm.test.ts`

**Interfaces:**

- Consumes: the existing SIMD helpers and memory layout in `lib.rs`; `WasmDelimiterScanner` in `wasm_module.ts`.
- Produces: kernel export `scan_csv_cells(ho, hl, rowDelimiter, columnDelimiter, quote, crlf, insideQuotes, cellStartUnits, cellHasQuote, previousByte, ro, mc) -> count`; TypeScript type `WasmScanCsvCells`; `WasmDelimiterScanner.scanCsvCells`; constants `CELL_RESULT_HEADER = 5`, `CELL_RESULT_STRIDE = 3`, flags `CELL_FLAG_ROW_END = 1`, `CELL_FLAG_HAS_QUOTE = 2` exported from `wasm_module.ts`.

- [ ] **Step 1: Write the failing kernel test (raw result block through the instance)**

The kernel is reachable only through the loaded module, which `CharacterSequence` keeps private. For this task, test through a tiny test-only loader: `loadWasmModule()` is exported from `lib/core/wasm_module.js`, which is not on the package's public entry. Import it by relative path from the compiled output, the way `benchmarks/` imports internals.

Add to `test/core/wasm.test.ts`, inside the existing `describe("WASM SIMD scanner", ...)`:

```ts
import {
	CELL_FLAG_HAS_QUOTE,
	CELL_FLAG_ROW_END,
	CELL_RESULT_HEADER,
	CELL_RESULT_STRIDE,
	loadWasmModule,
} from "../../out/lib/core/wasm_module.js"

describe("scan_csv_cells", () => {
	/**
	 * Stage `bytes` at offset 0 and run the kernel once. Returns the header and the cells as plain numbers.
	 */
	async function scan(
		bytes: Uint8Array,
		{
			quote = 0x22,
			crlf = 1,
			insideQuotes = 0,
			cellStartUnits = 0,
			cellHasQuote = 0,
			previousByte = -1,
			maxCells = 64,
		} = {}
	) {
		const wasm = await loadWasmModule()

		if (!wasm) throw new Error("scanner unavailable")

		const resultsOffset = Math.ceil(bytes.length / 4) * 4
		const needed = resultsOffset + (CELL_RESULT_HEADER + maxCells * CELL_RESULT_STRIDE) * 4

		if (needed > wasm.memory.buffer.byteLength)
			wasm.memory.grow(Math.ceil((needed - wasm.memory.buffer.byteLength) / 65_536))

		new Uint8Array(wasm.memory.buffer, 0, bytes.length).set(bytes)

		const count = wasm.scanCsvCells(
			0,
			bytes.length,
			0x0a,
			0x2c,
			quote,
			crlf,
			insideQuotes,
			cellStartUnits,
			cellHasQuote,
			previousByte,
			resultsOffset,
			maxCells
		)
		const block = new Int32Array(wasm.memory.buffer, resultsOffset, CELL_RESULT_HEADER + count * CELL_RESULT_STRIDE)
		const cells: Array<[number, number, number]> = []

		for (let i = 0; i < count; i++) {
			const base = CELL_RESULT_HEADER + i * CELL_RESULT_STRIDE

			cells.push([block[base]!, block[base + 1]!, block[base + 2]!])
		}

		return {
			cursor: block[0]!,
			units: block[1]!,
			insideQuotes: block[2]!,
			cellStartUnits: block[3]!,
			cellHasQuote: block[4]!,
			cells,
		}
	}

	test("emits cells with row-end flags and leaves the tail open", async () => {
		const result = await scan(encoder.encode("a,bb\ncc,d"))

		expect(result.cells).toEqual([
			[0, 1, 0],
			[2, 4, CELL_FLAG_ROW_END],
			[5, 7, 0],
		])
		expect(result).toMatchObject({ cursor: 9, units: 9, insideQuotes: 0, cellStartUnits: 8, cellHasQuote: 0 })
	})

	test("a delimiter inside quotes is data, and the cell is flagged", async () => {
		const result = await scan(encoder.encode('"x,y",z\n'))

		expect(result.cells).toEqual([
			[0, 5, CELL_FLAG_HAS_QUOTE],
			[6, 7, CELL_FLAG_ROW_END],
		])
		expect(result.insideQuotes).toBe(0)
	})

	test("crlf drops the carriage return from the cell end, but not at EOF", async () => {
		const withCr = await scan(encoder.encode("a\r\nb\r"))

		expect(withCr.cells).toEqual([[0, 1, CELL_FLAG_ROW_END]])
		expect(withCr.cellStartUnits).toBe(3)
		expect(withCr.units).toBe(5)

		const raw = await scan(encoder.encode("a\r\nb\r"), { crlf: 0 })

		expect(raw.cells).toEqual([[0, 2, CELL_FLAG_ROW_END]])
	})

	test("a row delimiter at window start consults previous_byte for the carriage return", async () => {
		const result = await scan(encoder.encode("\nb"), { previousByte: 0x0d, cellStartUnits: -3 })

		// The open cell began three units before this window, and the CR is the unit just before the LF.
		expect(result.cells).toEqual([[-3, -1, CELL_FLAG_ROW_END]])
	})

	test("counts UTF-16 units: 2- and 3-byte sequences are one unit, 4-byte are two", async () => {
		const result = await scan(encoder.encode("é,한,😀,z\n"))

		expect(result.cells).toEqual([
			[0, 1, 0],
			[2, 3, 0],
			[4, 6, 0],
			[7, 8, CELL_FLAG_ROW_END],
		])
		expect(result.units).toBe(9)
	})

	test("a continuation byte at window start counts zero units", async () => {
		const bytes = encoder.encode("😀,a")

		// Split the emoji: the first window is its first two bytes, the second window the rest.
		const first = await scan(bytes.subarray(0, 2), { maxCells: 64 })

		expect(first.units).toBe(2)
		expect(first.cells).toEqual([])

		const second = await scan(bytes.subarray(2), { cellStartUnits: -2 })

		expect(second.units).toBe(3)
		expect(second.cells).toEqual([[-2, 0, 0]])
	})

	test("stops when max_cells is reached, with the cursor just past the delimiter that filled it", async () => {
		const result = await scan(encoder.encode("a,b,c\n"), { maxCells: 1 })

		expect(result.cells).toEqual([[0, 1, 0]])
		expect(result).toMatchObject({ cursor: 2, units: 2, cellStartUnits: 2 })
	})

	test("carries an open quoted cell across calls", async () => {
		const first = await scan(encoder.encode('"ab'))

		expect(first).toMatchObject({ cursor: 3, units: 3, insideQuotes: 1, cellStartUnits: 0, cellHasQuote: 1 })

		const second = await scan(encoder.encode('c",d\n'), { insideQuotes: 1, cellStartUnits: -3, cellHasQuote: 1 })

		expect(second.cells).toEqual([
			[-3, 2, CELL_FLAG_HAS_QUOTE],
			[3, 4, CELL_FLAG_ROW_END],
		])
	})

	test("quote handling off treats the quote byte as data", async () => {
		const result = await scan(encoder.encode('"a,b"\n'), { quote: -1 })

		expect(result.cells).toEqual([
			[0, 2, 0],
			[3, 5, CELL_FLAG_ROW_END],
		])
	})

	test("a window longer than 16 bytes with matches in every vector agrees with a scalar oracle", async () => {
		const text = Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? `"q${i},x"` : `c${i}é`)).join(",") + "\n"
		const bytes = encoder.encode(text)
		const result = await scan(bytes, { maxCells: 4096 })
		const expected: Array<[number, number, number]> = []
		let start = 0

		for (let i = 0; i < text.length; i++) {
			if (text[i] === ",") {
				const cell = text.slice(start, i)

				expected.push([start, i, cell.includes('"') ? CELL_FLAG_HAS_QUOTE : 0])
				start = i + 1
			}
		}

		expected.push([start, text.length - 1, CELL_FLAG_ROW_END])
		expect(result.cells).toEqual(expected)
	})
})
```

Note: the oracle above splits on every comma because every quoted cell in it closes before its comma; the point of the test is vector-boundary agreement, not quote semantics.

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test --run test/core/wasm.test.ts -t "scan_csv_cells"`
Expected: FAIL, `loadWasmModule(...).scanCsvCells is not a function` (or the import of `CELL_RESULT_HEADER` is undefined).

- [ ] **Step 3: Add the kernel**

Append to `wasm/src/lib.rs` after `write_range_scan_state`:

```rust
// ── scan_csv_cells ────────────────────────────────────────────

const CELL_RESULT_HEADER: usize = 5;
const CELL_RESULT_STRIDE: usize = 3;
const CELL_FLAG_ROW_END: i32 = 1;
const CELL_FLAG_HAS_QUOTE: i32 = 2;

/// Resumable single-pass CSV cell scan. Emits `[start, end, flags]` per cell in UTF-16 code
/// units relative to the window's unit base, tracking quote state and counting units from the
/// UTF-8 lead-byte pattern. See docs/superpowers/specs/2026-09-27-csv-bulk-cell-scan-design.md.
///
/// Results block (i32): [cursor, units, inside_quotes, cell_start_units, cell_has_quote, cells...]
#[no_mangle]
pub unsafe extern "C" fn scan_csv_cells(
    haystack_offset: usize,
    haystack_len: usize,
    row_delimiter: u32,
    column_delimiter: u32,
    quote: i32,
    crlf: i32,
    inside_quotes: i32,
    cell_start_units: i32,
    cell_has_quote: i32,
    previous_byte: i32,
    results_offset: usize,
    max_cells: usize,
) -> usize {
    let results = results_offset as *mut i32;
    let haystack = haystack_offset as *const u8;
    let row_byte = row_delimiter as u8;
    let col_byte = column_delimiter as u8;
    let quote_enabled = quote >= 0;
    let quote_byte = quote as u8;
    let crlf = crlf != 0;

    let mut cursor = 0usize;
    let mut units: i32 = 0;
    let mut quoted = inside_quotes != 0;
    let mut cell_start = cell_start_units;
    let mut has_quote = cell_has_quote != 0;
    let mut count = 0usize;

    let row_splat = i8x16_splat(row_byte as i8);
    let col_splat = i8x16_splat(col_byte as i8);
    let quote_splat = i8x16_splat(quote_byte as i8);
    let cont_mask_splat = u8x16_splat(0xC0);
    let cont_value_splat = u8x16_splat(0x80);
    let four_splat = u8x16_splat(0xF0);

    // Units contributed by a byte at `offset`: 1 unless it is a continuation byte, plus 1 more
    // for a 4-byte lead. The scalar tail and the in-vector prefix both use this.
    #[inline(always)]
    fn byte_units(b: u8) -> i32 {
        if b & 0xC0 == 0x80 {
            0
        } else if b >= 0xF0 {
            2
        } else {
            1
        }
    }

    // Closes the open cell at byte `offset`, whose unit offset is `units_at`. Returns false when
    // the result block is full (the caller then writes state and returns without consuming).
    #[inline(always)]
    unsafe fn close_cell(
        results: *mut i32,
        count: &mut usize,
        max_cells: usize,
        cell_start: &mut i32,
        has_quote: &mut bool,
        units_at: i32,
        end_units: i32,
        row_end: bool,
    ) -> bool {
        if *count >= max_cells {
            return false;
        }

        let base = CELL_RESULT_HEADER + *count * CELL_RESULT_STRIDE;
        let mut flags = 0;

        if row_end {
            flags |= CELL_FLAG_ROW_END;
        }

        if *has_quote {
            flags |= CELL_FLAG_HAS_QUOTE;
        }

        *results.add(base) = *cell_start;
        *results.add(base + 1) = end_units;
        *results.add(base + 2) = flags;
        *count += 1;
        // The delimiter is one ASCII byte, one unit.
        *cell_start = units_at + 1;
        *has_quote = false;

        true
    }

    // Returns the unit offset at which the cell ends for a row delimiter at `offset`:
    // one unit short when crlf is on and the byte before is CR, and that CR is inside the cell.
    #[inline(always)]
    unsafe fn row_end_units(
        haystack: *const u8,
        offset: usize,
        previous_byte: i32,
        crlf: bool,
        units_at: i32,
        cell_start: i32,
    ) -> i32 {
        if !crlf {
            return units_at;
        }

        let before = if offset == 0 { previous_byte } else { *haystack.add(offset - 1) as i32 };

        if before == 0x0D && units_at - 1 >= cell_start {
            units_at - 1
        } else {
            units_at
        }
    }

    while cursor + 16 <= haystack_len {
        let chunk = v128_load(haystack.add(cursor) as *const v128);
        let row_mask = i8x16_bitmask(i8x16_eq(chunk, row_splat)) as u32;
        let col_mask = i8x16_bitmask(i8x16_eq(chunk, col_splat)) as u32;
        let quote_mask = if quote_enabled {
            i8x16_bitmask(i8x16_eq(chunk, quote_splat)) as u32
        } else {
            0
        };
        let cont_mask = i8x16_bitmask(u8x16_eq(v128_and(chunk, cont_mask_splat), cont_value_splat)) as u32;
        let noncont_mask = !cont_mask & 0xFFFF;
        let four_mask = i8x16_bitmask(u8x16_ge(chunk, four_splat)) as u32;
        let chunk_units = (noncont_mask.count_ones() + four_mask.count_ones()) as i32;
        let mut matches = row_mask | col_mask | quote_mask;

        while matches != 0 {
            let position = matches.trailing_zeros();
            let offset = cursor + position as usize;
            let before_mask = (1u32 << position) - 1;
            let units_at = units + ((noncont_mask & before_mask).count_ones() + (four_mask & before_mask).count_ones()) as i32;
            let is_row = (row_mask >> position) & 1 != 0;
            let is_col = (col_mask >> position) & 1 != 0;

            if is_row || is_col {
                if !quoted {
                    let end_units = if is_row {
                        row_end_units(haystack, offset, previous_byte, crlf, units_at, cell_start)
                    } else {
                        units_at
                    };

                    if !close_cell(results, &mut count, max_cells, &mut cell_start, &mut has_quote, units_at, end_units, is_row) {
                        write_cell_scan_state(results, offset, units_at, quoted, cell_start, has_quote);
                        return count;
                    }
                }
            } else {
                quoted = !quoted;
                has_quote = true;
            }

            matches &= matches - 1;
        }

        units += chunk_units;
        cursor += 16;
    }

    while cursor < haystack_len {
        let byte = *haystack.add(cursor);

        if byte == row_byte || byte == col_byte {
            if !quoted {
                let is_row = byte == row_byte;
                let end_units = if is_row {
                    row_end_units(haystack, cursor, previous_byte, crlf, units, cell_start)
                } else {
                    units
                };

                if !close_cell(results, &mut count, max_cells, &mut cell_start, &mut has_quote, units, end_units, is_row) {
                    write_cell_scan_state(results, cursor, units, quoted, cell_start, has_quote);
                    return count;
                }
            }
        } else if quote_enabled && byte == quote_byte {
            quoted = !quoted;
            has_quote = true;
        }

        units += byte_units(byte);
        cursor += 1;
    }

    write_cell_scan_state(results, haystack_len, units, quoted, cell_start, has_quote);
    count
}

#[inline]
unsafe fn write_cell_scan_state(
    results: *mut i32,
    cursor: usize,
    units: i32,
    inside_quotes: bool,
    cell_start_units: i32,
    cell_has_quote: bool,
) {
    *results = cursor as i32;
    *results.add(1) = units;
    *results.add(2) = if inside_quotes { 1 } else { 0 };
    *results.add(3) = cell_start_units;
    *results.add(4) = if cell_has_quote { 1 } else { 0 };
}
```

Two things to keep straight when the file is edited: `u8x16_ge` and `u8x16_eq` are the unsigned comparisons from `core::arch::wasm32` (the existing code uses `i8x16_eq`, which is bitwise identical for equality; `ge` must be unsigned). When a row or column delimiter is consumed, the byte that closed the cell is one unit, and `close_cell` sets the next cell's start to `units_at + 1` before the outer loop adds the delimiter's own unit count, which is consistent because the delimiter is ASCII.

Update the module header comment's export list to add `scan_csv_cells: resumable CSV cell scan with UTF-16 unit counting → cells + state`.

- [ ] **Step 4: Bind it in `wasm_module.ts`**

In `lib/core/wasm_module.ts`, add after `WasmScanDelimitedRanges`:

```ts
// oxlint-disable-next-line eslint/max-params
type WasmScanCsvCells = (
	ho: number,
	hl: number,
	rowDelimiter: number,
	columnDelimiter: number,
	quote: number,
	crlf: number,
	insideQuotes: number,
	cellStartUnits: number,
	cellHasQuote: number,
	previousByte: number,
	ro: number,
	mc: number
) => number
```

Add `scanCsvCells: WasmScanCsvCells` to `WasmDelimiterScanner`, and in `loadWasmModule` add `const scanCsvCells = e.scan_csv_cells as WasmScanCsvCells` and include it in the returned object.

Add after `WASM_MAX_RESULTS`:

```ts
/**
 * Layout of `scan_csv_cells`'s result block: five header ints, then three per cell.
 */
export const CELL_RESULT_HEADER = 5
export const CELL_RESULT_STRIDE = 3
export const CELL_FLAG_ROW_END = 1
export const CELL_FLAG_HAS_QUOTE = 2

/**
 * One owned batch from the CSV cell scanner, rebased to absolute offsets by `CharacterSequence.scanCells`.
 */
export interface WasmCellScanResult {
	/**
	 * `[start, end, flags]` triples in UTF-16 units of the decoded source. A copy, safe to hold across further scans.
	 */
	cells: Int32Array
	count: number
	/**
	 * Absolute byte offset the scan stopped at.
	 */
	scanCursor: number
	/**
	 * Absolute UTF-16 unit count at `scanCursor`.
	 */
	units: number
	insideQuotes: boolean
	/**
	 * Absolute UTF-16 start of the cell open at `scanCursor`.
	 */
	cellStartUnits: number
	cellHasQuote: boolean
}
```

- [ ] **Step 5: Rebuild the kernel**

Run: `bash wasm/build.sh`
Expected: `==> Building WASM with SIMD...` through `==> Writing TypeScript constant to lib/core/wasm_base64.ts...` with no error. `git status` shows `wasm/spliterator_wasm.wasm`, `wasm/src/lib.rs`, `lib/core/wasm_base64.ts`, `lib/core/wasm_module.ts` modified.

- [ ] **Step 6: Run the test to verify it passes**

Run: `yarn test --run test/core/wasm.test.ts -t "scan_csv_cells"`
Expected: PASS, 10 tests.

If "a window longer than 16 bytes" fails on the flag of a cell, check that `has_quote` is reset in `close_cell` and set on every quote byte, not only on toggles into quotes.

- [ ] **Step 7: Lint and full suite**

Run: `yarn lint:fix && yarn lint && yarn test --run`
Expected: lint prints nothing; all tests pass (existing count plus 10).

- [ ] **Step 8: Commit**

```bash
git add wasm/src/lib.rs wasm/spliterator_wasm.wasm lib/core/wasm_base64.ts lib/core/wasm_module.ts test/core/wasm.test.ts
git commit -m "WASM: scan_csv_cells, a resumable single-pass CSV cell scan in UTF-16 units"
```

---

### Task 2: `CharacterSequence.scanCells` wrapper

**Files:**

- Modify: `lib/core/CharacterSequence.ts` (add a static method after `scanRanges`)
- Test: `test/core/wasm.test.ts`

**Interfaces:**

- Consumes: `WasmDelimiterScanner.scanCsvCells`, `CELL_RESULT_*`, `WasmCellScanResult` (Task 1); private helpers `ensureWasmCapacity`, `alignTo4`, `CharacterSequence.#wasmScanner`, `#ensureWasm`, `#wasmHaystack`.
- Produces:

```ts
export interface CellScanState {
	scanCursor: number      // absolute byte offset to resume from
	units: number           // absolute UTF-16 units at scanCursor
	insideQuotes: boolean
	cellStartUnits: number  // absolute UTF-16 start of the open cell
	cellHasQuote: boolean
}

export interface CellScanOptions {
	rowDelimiter: number    // one ASCII byte
	columnDelimiter: number // one ASCII byte
	quote: number           // one byte, or -1 for no quote handling
	crlf: boolean
	maxCells?: number       // default WASM_MAX_RESULTS
}

// Returns null when the scanner is unavailable or the window is empty.
CharacterSequence.scanCells(haystack: Uint8Array, state: CellScanState, end: number, options: CellScanOptions): WasmCellScanResult | null
```

- [ ] **Step 1: Write the failing test**

Add to `test/core/wasm.test.ts` inside the outer describe:

```ts
describe("CharacterSequence.scanCells", () => {
	const options = { rowDelimiter: 0x0a, columnDelimiter: 0x2c, quote: 0x22, crlf: true }
	const initial = { scanCursor: 0, units: 0, insideQuotes: false, cellStartUnits: 0, cellHasQuote: false }

	test("rebases a window's cells and state to absolute offsets", () => {
		const bytes = encoder.encode("é,a\nbb,c")
		// Scan the first row only, then resume.
		const first = CharacterSequence.scanCells(bytes, initial, 5, options)!

		expect(Array.from(first.cells)).toEqual([0, 1, 0, 2, 3, CELL_FLAG_ROW_END])
		expect(first).toMatchObject({
			scanCursor: 5,
			units: 4,
			insideQuotes: false,
			cellStartUnits: 4,
			cellHasQuote: false,
		})

		const second = CharacterSequence.scanCells(bytes, first, bytes.length, options)!

		expect(Array.from(second.cells)).toEqual([4, 6, 0])
		expect(second).toMatchObject({ scanCursor: 9, units: 8, cellStartUnits: 7 })
	})

	test("a cell open across the window edge keeps its absolute start", () => {
		const bytes = encoder.encode('a,"b\nc",d\n')
		const first = CharacterSequence.scanCells(bytes, initial, 4, options)!

		expect(Array.from(first.cells)).toEqual([0, 1, 0])
		expect(first).toMatchObject({ scanCursor: 4, units: 4, insideQuotes: true, cellStartUnits: 2, cellHasQuote: true })

		const second = CharacterSequence.scanCells(bytes, first, bytes.length, options)!

		expect(Array.from(second.cells)).toEqual([2, 7, CELL_FLAG_HAS_QUOTE, 8, 9, CELL_FLAG_ROW_END])
	})

	test("supplies previous_byte so a CRLF split by the window is trimmed", () => {
		const bytes = encoder.encode("ab\r\ncd\n")
		const first = CharacterSequence.scanCells(bytes, initial, 3, options)!

		expect(first.count).toBe(0)

		const second = CharacterSequence.scanCells(bytes, first, bytes.length, options)!

		expect(Array.from(second.cells)).toEqual([0, 2, CELL_FLAG_ROW_END, 4, 6, CELL_FLAG_ROW_END])
	})

	test("returns an owned copy that survives a later scan", () => {
		const bytes = encoder.encode("a,b\n")
		const result = CharacterSequence.scanCells(bytes, initial, bytes.length, options)!
		const snapshot = Array.from(result.cells)

		CharacterSequence.scanCells(encoder.encode("zzzzzzzz,yyyyyyyy\n"), initial, 18, options)

		expect(Array.from(result.cells)).toEqual(snapshot)
	})

	test("honours maxCells and reports where it stopped", () => {
		const bytes = encoder.encode("a,b,c\n")
		const result = CharacterSequence.scanCells(bytes, initial, bytes.length, { ...options, maxCells: 2 })!

		expect(result.count).toBe(2)
		expect(result).toMatchObject({ scanCursor: 4, units: 4, cellStartUnits: 4 })
	})

	test("returns null for an empty window", () => {
		expect(
			CharacterSequence.scanCells(
				encoder.encode("a"),
				{ ...initial, scanCursor: 1, units: 1, cellStartUnits: 1 },
				1,
				options
			)
		).toBeNull()
	})
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test --run test/core/wasm.test.ts -t "CharacterSequence.scanCells"`
Expected: FAIL, `CharacterSequence.scanCells is not a function`.

- [ ] **Step 3: Implement the wrapper**

In `lib/core/CharacterSequence.ts`, extend the import from `./wasm_module.js` with `CELL_RESULT_HEADER, CELL_RESULT_STRIDE, type WasmCellScanResult`, add the two interfaces above (exported) before the class, and add this static method after `scanRanges`:

```ts
	/**
	 * Scan CSV cells over `[state.scanCursor, end)` in one bounded kernel call, returning an owned batch rebased to
	 * absolute byte and UTF-16 offsets. The kernel counts UTF-16 units as it scans, which is what lets the caller slice
	 * a decoded string by these offsets without an ASCII gate; the decode must be `fatal` so the count is exact.
	 *
	 * The batch is copied out of WASM memory before returning, so a caller may hold it across further scans, including
	 * a nested parse run by user code while a row is being consumed.
	 *
	 * Returns `null` when the scanner is unavailable or the window is empty. Callers keep their own fallback.
	 */
	public static scanCells(
		haystack: Uint8Array,
		state: CellScanState,
		end: number,
		options: CellScanOptions
	): WasmCellScanResult | null {
		const windowStart = Math.min(state.scanCursor, end)
		const windowLength = end - windowStart

		if (windowLength <= 0) return null

		const wasm = CharacterSequence.#wasmScanner

		if (!wasm) {
			if (CharacterSequence.#wasmScanner === undefined) {
				CharacterSequence.#ensureWasm()
			}

			return null
		}

		const maxCells = options.maxCells ?? WASM_MAX_RESULTS
		const resultsOffset = alignTo4(windowLength)
		const resultValueCount = CELL_RESULT_HEADER + maxCells * CELL_RESULT_STRIDE
		const totalNeeded = resultsOffset + resultValueCount * Int32Array.BYTES_PER_ELEMENT

		ensureWasmCapacity(wasm.memory, totalNeeded)
		new Uint8Array(wasm.memory.buffer, 0, windowLength).set(haystack.subarray(windowStart, end))
		// The haystack cache belongs to `search()`; staging over offset 0 invalidates it.
		CharacterSequence.#wasmHaystack = null

		const previousByte = windowStart > 0 ? haystack[windowStart - 1]! : -1

		const count = wasm.scanCsvCells(
			0,
			windowLength,
			options.rowDelimiter,
			options.columnDelimiter,
			options.quote,
			options.crlf ? 1 : 0,
			state.insideQuotes ? 1 : 0,
			// Window-relative; negative when the open cell began before this window.
			state.cellStartUnits - state.units,
			state.cellHasQuote ? 1 : 0,
			previousByte,
			resultsOffset,
			maxCells
		)

		const block = new Int32Array(wasm.memory.buffer, resultsOffset, CELL_RESULT_HEADER + count * CELL_RESULT_STRIDE)
		// Copy: the view aliases shared memory that the next scanner call overwrites.
		const cells = block.slice(CELL_RESULT_HEADER)
		const unitBase = state.units

		for (let i = 0; i < count; i++) {
			cells[i * CELL_RESULT_STRIDE] = cells[i * CELL_RESULT_STRIDE]! + unitBase
			cells[i * CELL_RESULT_STRIDE + 1] = cells[i * CELL_RESULT_STRIDE + 1]! + unitBase
		}

		return {
			cells,
			count,
			scanCursor: windowStart + block[0]!,
			units: unitBase + block[1]!,
			insideQuotes: block[2] === 1,
			cellStartUnits: unitBase + block[3]!,
			cellHasQuote: block[4] === 1,
		}
	}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test --run test/core/wasm.test.ts -t "CharacterSequence.scanCells"`
Expected: PASS, 6 tests.

- [ ] **Step 5: Lint, full suite, commit**

Run: `yarn lint:fix && yarn lint && yarn test --run`
Expected: lint prints nothing; all tests pass.

```bash
git add lib/core/CharacterSequence.ts test/core/wasm.test.ts
git commit -m "CharacterSequence.scanCells: owned, rebased batches from the CSV cell kernel"
```

---

### Task 3: `scanCsvCells` row generator with a String oracle

**Files:**

- Create: `lib/formats/csv-cells.ts`
- Modify: `lib/formats/csv-columns.ts` (export the shared cell normalizer; `splitRowColumns` uses it)
- Test: `test/formats/csv-cells.test.ts`

**Interfaces:**

- Consumes: `CharacterSequence.scanCells`, `CellScanState`, `CellScanOptions` (Task 2); `CELL_FLAG_*`, `CELL_RESULT_STRIDE` (Task 1).
- Produces:

```ts
// csv-columns.ts
export const DOUBLE_QUOTE_CODE = 0x22
export function unquoteColumn(value: string): string            // now exported
export function normalizeCell(value: string, enableQuoteHandling: boolean, trim: boolean): string

// csv-cells.ts
export interface CsvCellScanInit {
	rowDelimiter: number
	columnDelimiter: number
	enableQuoteHandling: boolean
	crlf: boolean
	trim: boolean
	skipEmpty: boolean
	windowSize?: number   // default CELL_SCAN_WINDOW (64 KiB); tests shrink it
	maxCells?: number     // default WASM_MAX_RESULTS; tests shrink it
}
export const CELL_SCAN_WINDOW = 64 * 1024
export function* scanCsvCells(source: Uint8Array, text: string, init: CsvCellScanInit): Generator<string[]>
```

`text` must be `new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source)`; the generator trusts that and throws nothing of its own.

- [ ] **Step 1: Write the failing tests, with the oracle**

Create `test/formats/csv-cells.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 * The fast cell scan against two oracles: the reference row path (`columnScan: "rows"` is what `CSVSpliterator` will
 * offer; here it is `Spliterator.fromSync` rows split by `splitRowColumns`), and, for the shape of the contract, a
 * String-derived expectation. Windows and batches are shrunk so every boundary case crosses one.
 */

import { CharacterSequence, Spliterator } from "spliterator"
import { beforeAll, describe, expect, test } from "vitest"

import { scanCsvCells } from "../../out/lib/formats/csv-cells.js"
import { splitRowColumns } from "../../out/lib/formats/csv-columns.js"

const encoder = new TextEncoder()
const lossy = new TextDecoder()

interface Case {
	enableQuoteHandling?: boolean
	crlf?: boolean
	trim?: boolean
	skipEmpty?: boolean
	columnDelimiter?: number
}

/**
 * What the row path yields for `text` under the same options: the parity oracle.
 */
function reference(text: string, opts: Case = {}): string[][] {
	const { enableQuoteHandling = true, crlf = true, trim = false, skipEmpty = true, columnDelimiter = 0x2c } = opts
	const bytes = encoder.encode(text)
	const columns = new CharacterSequence(columnDelimiter)
	const rows: string[][] = []

	for (const row of Spliterator.fromSync(bytes, { delimiter: 0x0a, crlf, enableQuoteHandling, skipEmpty })) {
		rows.push(splitRowColumns(row, columns, lossy, enableQuoteHandling, trim))
	}

	return rows
}

function fast(text: string, opts: Case = {}, windowSize = 7, maxCells = 3): string[][] {
	const { enableQuoteHandling = true, crlf = true, trim = false, skipEmpty = true, columnDelimiter = 0x2c } = opts
	const bytes = encoder.encode(text)
	const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)

	return Array.from(
		scanCsvCells(bytes, decoded, {
			rowDelimiter: 0x0a,
			columnDelimiter,
			enableQuoteHandling,
			crlf,
			trim,
			skipEmpty,
			windowSize,
			maxCells,
		})
	)
}

beforeAll(async () => {
	if (!(await CharacterSequence.whenReady())) throw new Error("WASM SIMD scanner must be available")
})

describe("scanCsvCells parity with the row path", () => {
	const inputs: Array<[string, string, Case?]> = [
		["plain", "a,b\nc,d\n"],
		["no trailing delimiter", "a,b\nc,d"],
		["empty source", ""],
		["single cell", "x"],
		["single empty line", "\n"],
		["empty rows kept", "a\n\n\nb\n", { skipEmpty: false }],
		["empty rows dropped", "a\n\n\nb\n"],
		["empty cells", ",,\n,a,\n"],
		["trailing column delimiter", "a,b,\n"],
		["crlf on", "a,b\r\nc,d\r\n"],
		["crlf off", "a,b\r\nc,d\r\n", { crlf: false }],
		["crlf-only line is empty", "a\r\n\r\nb\r\n"],
		["crlf-only line kept", "a\r\n\r\nb\r\n", { skipEmpty: false }],
		["lone cr is data", "a\rb,c\n"],
		["cr at eof", "a,b\r"],
		["quoted delimiter", 'a,"b,c",d\n'],
		["quoted newline", 'a,"b\nc",d\n'],
		["doubled quote", 'a,"b""c"\n'],
		["quote-only cell", '"",a\n'],
		["quote-only line is not empty", '""\n'],
		["unmatched quote runs to eof", 'a,"b,c\nd,e\n'],
		["unmatched quote mid-cell", '5" pipe,b\n'],
		["quotes off", 'a,"b,c"\n', { enableQuoteHandling: false }],
		["padding outside quotes with trim", ' " Ada " , 36 \n', { trim: true }],
		["trim", "  a , b  \n c ,d\n", { trim: true }],
		["whitespace-only line is not empty", "a\n   \nb\n"],
		["utf8 widths", "é,한,😀,z\né한😀,x\n"],
		["utf8 at every offset", "😀😀😀😀,a\nb,😀\n"],
		["bom at source start", "﻿a,b\nc,d\n"],
		["bom at row starts", "﻿a,b\n﻿c,d\n"],
		["bom after column delimiter stays", "a,﻿b\n"],
		["bom inside quotes stays", '"﻿a",b\n'],
		["bom-only row", "﻿\na\n"],
		["bom-only single cell", "﻿"],
		["repeated bom", "﻿﻿a\n"],
		["tab columns", "a\tb\nc\td\n", { columnDelimiter: 0x09 }],
		["pipe columns", "a|b\nc|d\n", { columnDelimiter: 0x7c }],
	]

	test.each(inputs)("%s", (_label, text, opts) => {
		expect(fast(text, opts)).toEqual(reference(text, opts))
	})

	test.each(inputs)("%s, wide window and batch", (_label, text, opts) => {
		expect(fast(text, opts, 64 * 1024, 4096)).toEqual(reference(text, opts))
	})

	test("a quoted newline straddling the window", () => {
		const text = 'a,"bbbbbbbb\ncccccccc",d\ne,f\n'

		for (let windowSize = 1; windowSize <= text.length + 1; windowSize++) {
			expect(fast(text, {}, windowSize, 2), `window ${windowSize}`).toEqual(reference(text))
		}
	})

	test("a supplementary character straddling the window", () => {
		const text = "😀,a\nbb,😀\n"

		for (let windowSize = 1; windowSize <= 16; windowSize++) {
			expect(fast(text, {}, windowSize, 2), `window ${windowSize}`).toEqual(reference(text))
		}
	})

	test("CRLF straddling the window", () => {
		const text = "ab\r\ncd\r\n"

		for (const crlf of [true, false]) {
			for (let windowSize = 1; windowSize <= text.length + 1; windowSize++) {
				expect(fast(text, { crlf }, windowSize, 2), `crlf ${crlf} window ${windowSize}`).toEqual(
					reference(text, { crlf })
				)
			}
		}
	})

	test("a BOM-only single-cell source", () => {
		for (const skipEmpty of [true, false]) {
			expect(fast("﻿", { skipEmpty })).toEqual(reference("﻿", { skipEmpty }))
		}
	})

	test("a row wider than the batch and longer than the window", () => {
		const cells = Array.from({ length: 50 }, (_, i) => `cell${i}`)
		const text = cells.join(",") + "\n" + cells.join(",")

		expect(fast(text, {}, 16, 3)).toEqual(reference(text))
	})

	test("a large mixed source with the production window and batch", () => {
		const rows: string[] = []

		for (let i = 0; i < 30_000; i++) {
			rows.push(i % 5 === 0 ? `${i},"q, ""${i}""\nmore",é한😀` : `${i},plain ${i},x`)
		}

		const text = rows.join("\r\n") + "\r\n"

		expect(fast(text, {}, 64 * 1024, 4096)).toEqual(reference(text))
	})
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test --run test/formats/csv-cells.test.ts`
Expected: FAIL at import, `Cannot find module '.../out/lib/formats/csv-cells.js'`.

- [ ] **Step 3: Share the cell normalizer from `csv-columns.ts`**

In `lib/formats/csv-columns.ts`, export `DOUBLE_QUOTE_CODE` and `unquoteColumn`, and replace the trim loop in `splitRowColumns` with a call to a new exported function, so both paths mean the same thing by "normalize a cell":

```ts
export const DOUBLE_QUOTE_CODE = 0x22

/**
 * Strip wrapping quotes and unescape doubled quotes (`""` → `"`). Allocates only when the field was actually quoted.
 */
export function unquoteColumn(value: string): string {
	if (value.length >= 2 && value.charCodeAt(0) === DOUBLE_QUOTE_CODE && value.endsWith('"')) {
		return value.slice(1, -1).replaceAll('""', '"')
	}

	return value
}

/**
 * The trim step both column paths apply. Most cells have nothing to trim, and reading the two edge code units is far
 * cheaper than the `trim` call that would find that out. Padding outside the quotes (` " Ada " `) is malformed under
 * RFC 4180 but common: the edge-based unquote could not see the quotes, so unquote what trimming exposed, then trim
 * what was inside.
 */
export function normalizeCell(value: string, enableQuoteHandling: boolean, trim: boolean): string {
	if (!trim) return value

	const length = value.length

	if (length === 0 || (!mayNeedTrim(value.charCodeAt(0)) && !mayNeedTrim(value.charCodeAt(length - 1)))) {
		return value
	}

	let column = value.trim()

	if (enableQuoteHandling && column.charCodeAt(0) === DOUBLE_QUOTE_CODE) {
		column = unquoteColumn(column).trim()
	}

	return column
}
```

and `splitRowColumns` becomes:

```ts
export function splitRowColumns(
	row: Uint8Array,
	columnDelimiter: CharacterSequence,
	decoder: TextDecoder,
	enableQuoteHandling: boolean,
	trim = false
): string[] {
	const columns = splitRowColumnsRaw(row, columnDelimiter, decoder, enableQuoteHandling)

	if (trim) {
		for (let i = 0; i < columns.length; i++) {
			columns[i] = normalizeCell(columns[i]!, enableQuoteHandling, true)
		}
	}

	return columns
}
```

Delete the now-unused local `const DOUBLE_QUOTE_CODE` and the old inline loop; keep `mayNeedTrim`.

- [ ] **Step 4: Write `csv-cells.ts`**

Create `lib/formats/csv-cells.ts`:

```ts
/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { CharacterSequence, type CellScanState } from "../core/CharacterSequence.js"
import { CELL_FLAG_HAS_QUOTE, CELL_FLAG_ROW_END, CELL_RESULT_STRIDE, WASM_MAX_RESULTS } from "../core/wasm_module.js"
import { normalizeCell, unquoteColumn } from "./csv-columns.js"

/**
 * Bytes staged into the kernel per call. The kernel copies `[cursor, end)` into WASM memory each time, so the window
 * bounds that copy; the record open at a window's edge resumes through the carried state.
 */
export const CELL_SCAN_WINDOW = 64 * 1024

const BOM = 0xfeff

export interface CsvCellScanInit {
	rowDelimiter: number
	columnDelimiter: number
	enableQuoteHandling: boolean
	crlf: boolean
	trim: boolean
	skipEmpty: boolean
	/**
	 * @default CELL_SCAN_WINDOW
	 */
	windowSize?: number
	/**
	 * @default WASM_MAX_RESULTS
	 */
	maxCells?: number
}

/**
 * Yield every row of a wholly in-memory CSV as `string[]`, slicing cells out of `text` at the boundaries the kernel
 * emits. `text` must be `source` decoded with `{ fatal: true, ignoreBOM: true }`: `fatal` is what makes the kernel's
 * UTF-16 unit count exact, and `ignoreBOM` keeps every U+FEFF in the string so the offsets line up; the one BOM the
 * row path strips at the start of each row is stripped here per row.
 *
 * Row emptiness follows `Spliterator`: a row is empty when its byte range after CRLF removal is empty, before any
 * BOM removal, unquoting or trimming. `""`, a BOM-only row and `,,` are not empty.
 *
 * The caller has established eligibility (single ASCII delimiters, scanner loaded); this generator throws nothing of
 * its own and yields nothing until first pulled.
 */
export function* scanCsvCells(source: Uint8Array, text: string, init: CsvCellScanInit): Generator<string[]> {
	const { rowDelimiter, columnDelimiter, enableQuoteHandling, crlf, trim, skipEmpty } = init
	const windowSize = init.windowSize ?? CELL_SCAN_WINDOW
	const maxCells = init.maxCells ?? WASM_MAX_RESULTS
	const options = { rowDelimiter, columnDelimiter, quote: enableQuoteHandling ? 0x22 : -1, crlf, maxCells }
	const length = source.byteLength

	let state: CellScanState = { scanCursor: 0, units: 0, insideQuotes: false, cellStartUnits: 0, cellHasQuote: false }
	let row: string[] = []
	// UTF-16 start of the row being assembled, for the emptiness test.
	let rowStart = 0
	let rowsEmitted = 0

	const cell = (start: number, end: number, hasQuote: boolean): string => {
		// The row path decodes each row on its own, which strips one BOM at the row's start.
		if (row.length === 0 && start < end && text.charCodeAt(start) === BOM) start++

		let value = text.slice(start, end)

		if (hasQuote && enableQuoteHandling) value = unquoteColumn(value)

		return normalizeCell(value, enableQuoteHandling, trim)
	}

	while (state.scanCursor < length) {
		const end = Math.min(length, state.scanCursor + windowSize)
		const scan = CharacterSequence.scanCells(source, state, end, options)

		if (!scan) {
			// The scanner is loaded (the caller checked) and the window is not empty, so this cannot happen; treat it
			// as a contract violation rather than looping.
			throw new Error("scanCsvCells: the cell scanner returned no batch for a non-empty window")
		}

		const cells = scan.cells

		for (let i = 0; i < scan.count; i++) {
			const start = cells[i * CELL_RESULT_STRIDE]!
			const cellEnd = cells[i * CELL_RESULT_STRIDE + 1]!
			const flags = cells[i * CELL_RESULT_STRIDE + 2]!

			row.push(cell(start, cellEnd, (flags & CELL_FLAG_HAS_QUOTE) !== 0))

			if (flags & CELL_FLAG_ROW_END) {
				// Empty means the raw row range is empty: one cell, and it spans nothing after CRLF removal.
				const empty = row.length === 1 && cellEnd === rowStart

				if (!(empty && skipEmpty)) {
					yield row
					rowsEmitted++
				}

				row = []
				// The next row starts where the next cell starts; when this cell closed the batch, the carried state
				// holds that offset.
				rowStart = i + 1 < scan.count ? cells[(i + 1) * CELL_RESULT_STRIDE]! : scan.cellStartUnits
			}
		}

		state = scan
	}

	// The tail after the last delimiter, as `Spliterator.#drain` leaves it: never CRLF-trimmed.
	const tailStart = state.cellStartUnits
	const tailEnd = text.length

	if (tailStart < tailEnd) {
		row.push(cell(tailStart, tailEnd, state.cellHasQuote))
		yield row
	} else if (row.length > 0) {
		// A row whose last cell is empty: `a,` at EOF.
		row.push(cell(tailStart, tailEnd, false))
		yield row
	} else if (rowsEmitted === 0 && length === 0) {
		// An empty source is one empty row, dropped by skipEmpty.
		if (!skipEmpty) yield [""]
	} else if (!skipEmpty) {
		// The source ended on a row delimiter: one trailing empty row, matching String.split.
		yield [""]
	}
}
```

One subtlety in the emptiness test: `cellEnd` is already CRLF-trimmed by the kernel, and `rowStart` is the untrimmed start, so `a\r\n` gives `cellEnd === rowStart + 1`, not empty, and `\r\n` alone gives `cellEnd === rowStart`, empty, exactly as the row path's byte range would be.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn test --run test/formats/csv-cells.test.ts`
Expected: PASS, all cases in both window configurations plus the six boundary tests.

If "bom at row starts" fails, check that the BOM strip runs only when `row.length === 0`, and that `ignoreBOM: true` is set in the test's decoder. If "empty rows kept" yields one row too few at the end, check the trailing-delimiter branch yields `[""]` when `!skipEmpty`.

- [ ] **Step 6: Lint, full suite, commit**

Run: `yarn lint:fix && yarn lint && yarn test --run`
Expected: lint prints nothing; all tests pass, including the existing CSV suites that now go through `normalizeCell`.

```bash
git add lib/formats/csv-cells.ts lib/formats/csv-columns.ts test/formats/csv-cells.test.ts
git commit -m "csv-cells: rows from one decode and one kernel pass, parity-tested against the row path"
```

---

### Task 4: Eligibility and the sync path (`columnScan` option, `CSVSpliterator.from`)

**Files:**

- Modify: `lib/formats/CSVSpliterator.ts` (option, `splitRows`)
- Modify: `lib/formats/csv-cells.ts` (add `cellScanEligibility`)
- Test: `test/formats/CSVSpliterator.test.ts`

**Interfaces:**

- Consumes: `scanCsvCells`, `CsvCellScanInit` (Task 3); `CharacterSequence.scanCells` (Task 2); `normalizeCharacterInput`.
- Produces:

```ts
// CSVSpliteratorInit
columnScan?: "auto" | "rows"

// csv-cells.ts
export interface CellScanPlan {
	rowDelimiter: number
	columnDelimiter: number
}
/**
 * Returns the single-byte delimiters when the fast path may run, else null. Does not decode.
 */
export function cellScanEligibility(init: {
	columnScan: "auto" | "rows"
	rowDelimiter: Uint8Array
	columnDelimiter: Uint8Array
	enableQuoteHandling: boolean
	position: number | undefined
	byteLength: number
}): CellScanPlan | null
export const MAX_CELL_SCAN_BYTES = 2 ** 29 - 2 ** 20   // under V8's string length limit, with headroom
export function decodeForCellScan(bytes: Uint8Array): string | null   // fatal decode; null on invalid UTF-8
```

- [ ] **Step 1: Write the failing tests**

Add to `test/formats/CSVSpliterator.test.ts` (extend the vitest import with `describe, vi`; add `CharacterSequence` to the spliterator import):

```ts
describe("columnScan", () => {
	const encoder = new TextEncoder()

	function both<T>(source: Uint8Array | string, init: Parameters<typeof CSVSpliterator.from>[1]) {
		const spy = vi.spyOn(CharacterSequence, "scanCells")
		const auto = CSVSpliterator.from(source, { ...init, columnScan: "auto" }).toArray()
		const autoCalls = spy.mock.calls.length

		spy.mockClear()

		const rows = CSVSpliterator.from(source, { ...init, columnScan: "rows" }).toArray()

		expect(spy).not.toHaveBeenCalled()
		spy.mockRestore()

		return { auto, rows, fastPathRan: autoCalls > 0 }
	}

	test("the fast path yields what the row path yields, and actually ran", async ({ expect }) => {
		await CharacterSequence.whenReady()

		for (const mode of ["array", "object", "entries"] as const) {
			for (const trim of [true, false]) {
				for (const header of [true, false]) {
					if (mode !== "array" && !header) continue

					const result = both(fixture.bytes, { mode, trim, header } as never)

					expect(result.auto, `${mode} trim=${trim} header=${header}`).toEqual(result.rows)
					expect(result.fastPathRan).toBe(true)
				}
			}
		}
	})

	test("transformers, normalizeKeys, drop and take behave the same on both paths", async ({ expect }) => {
		await CharacterSequence.whenReady()

		const calls = { auto: 0, rows: 0 }
		const src = ' Name , Age \n " Ada " , 36 \r\nBob,  41\nCy,7\n'

		for (const columnScan of ["auto", "rows"] as const) {
			const out = CSVSpliterator.from(src, {
				columnScan,
				drop: 1,
				take: 2,
				transformers: {
					age: (v) => {
						calls[columnScan]++
						return Number(v)
					},
				},
			}).toArray()

			expect(out).toEqual([
				{ name: "Bob", age: 41 },
				{ name: "Cy", age: 7 },
			])
		}

		expect(calls.auto).toBe(calls.rows)
	})

	test("a string source is eligible", async ({ expect }) => {
		await CharacterSequence.whenReady()

		const result = both("a,b\n1,2\n", { header: false, mode: "array" })

		expect(result.auto).toEqual([
			["a", "b"],
			["1", "2"],
		])
		expect(result.fastPathRan).toBe(true)
	})

	test("a byte view with a nonzero offset is eligible and correct", async ({ expect }) => {
		await CharacterSequence.whenReady()

		const backing = encoder.encode("XXXXa,b\n1,2\nYYYY")
		const view = backing.subarray(4, backing.length - 4)
		const result = both(view, { header: false, mode: "array" })

		expect(result.auto).toEqual([
			["a", "b"],
			["1", "2"],
		])
		expect(result.fastPathRan).toBe(true)
	})

	test("invalid UTF-8 falls back to the row path and yields U+FFFD", async ({ expect }) => {
		await CharacterSequence.whenReady()

		const bytes = new Uint8Array([0x61, 0x2c, 0xff, 0x0a])
		const result = both(bytes, { header: false, mode: "array" })

		expect(result.auto).toEqual([["a", "�"]])
		expect(result.auto).toEqual(result.rows)
		expect(result.fastPathRan).toBe(false)
	})

	test.each([
		["multi-byte column delimiter", { columnDelimiter: "::" }],
		["column delimiter equal to the row delimiter", { columnDelimiter: "\n" }],
		["non-ASCII single-byte column delimiter", { columnDelimiter: new Uint8Array([0xff]) }],
		["quote byte as column delimiter", { columnDelimiter: '"' }],
		["carriage return as column delimiter", { columnDelimiter: "\r" }],
		["multi-byte row delimiter", { delimiter: "\r\n" }],
		["nonzero position", { position: 2 }],
		["columnScan rows", { columnScan: "rows" }],
	] as const)("%s takes the row path", async (_label, init) => {
		await CharacterSequence.whenReady()

		const spy = vi.spyOn(CharacterSequence, "scanCells")

		CSVSpliterator.from("a,b\n1,2\n", { header: false, mode: "array", ...init } as never).toArray()

		expect(spy).not.toHaveBeenCalled()
		spy.mockRestore()
	})

	test("take(0) on the sequence yields nothing and does not decode", async ({ expect }) => {
		await CharacterSequence.whenReady()

		const spy = vi.spyOn(CharacterSequence, "scanCells")

		expect(CSVSpliterator.from("a,b\n1,2\n", { header: false, mode: "array" }).take(0).toArray()).toEqual([])
		expect(spy).not.toHaveBeenCalled()
		spy.mockRestore()
	})

	test("a header normalization failure propagates once and is not retried on the row path", async ({ expect }) => {
		await CharacterSequence.whenReady()

		let calls = 0
		const boom = () => {
			calls++
			throw new Error("boom")
		}

		expect(() => CSVSpliterator.from("a,b\n1,2\n", { transformers: { a: boom } }).toArray()).toThrow("boom")
		expect(calls).toBe(1)
	})
})
```

`fixture.bytes` is the `Uint8Array` that `loadFixture` in `test/support/utils.ts` returns alongside `decodedLines`.

Also add, in the same describe, the isolated-process test that the scanner-unavailable case takes the row path with identical output:

```ts
test("without the scanner loaded, from() takes the row path in a fresh process", async ({ expect }) => {
	const { execFile } = await import("node:child_process")
	const { promisify } = await import("node:util")
	const script = `
			import { CSVSpliterator, CharacterSequence } from "${new URL("../../out/index.js", import.meta.url).pathname}"
			const before = CSVSpliterator.from("a,b\\n1,2\\n", { header: false, mode: "array" }).toArray()
			const ready = await CharacterSequence.whenReady()
			const after = CSVSpliterator.from("a,b\\n1,2\\n", { header: false, mode: "array" }).toArray()
			console.log(JSON.stringify({ before, after, ready }))
		`
	const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script])

	expect(JSON.parse(stdout)).toEqual({
		before: [
			["a", "b"],
			["1", "2"],
		],
		after: [
			["a", "b"],
			["1", "2"],
		],
		ready: true,
	})
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test --run test/formats/CSVSpliterator.test.ts -t "columnScan"`
Expected: FAIL; `fastPathRan` is false everywhere (no `columnScan` handling exists), and the eligibility table's `columnScan: "rows"` case passes vacuously.

- [ ] **Step 3: Add eligibility and decode helpers to `csv-cells.ts`**

Append to `lib/formats/csv-cells.ts`:

```ts
/**
 * The largest source the fast path decodes whole. V8 refuses strings above ~2^29 characters; a source near that size
 * takes the row path rather than throwing a `RangeError` from the decoder, which is not the error the fallback catches.
 */
export const MAX_CELL_SCAN_BYTES = 2 ** 29 - 2 ** 20

export interface CellScanPlan {
	rowDelimiter: number
	columnDelimiter: number
}

const CARRIAGE_RETURN = 0x0d
const DOUBLE_QUOTE = 0x22

/**
 * Whether the fast path may run, and with which bytes. Cheap and decode-free; the decode is the one remaining gate.
 */
export function cellScanEligibility(init: {
	columnScan: "auto" | "rows"
	rowDelimiter: Uint8Array
	columnDelimiter: Uint8Array
	enableQuoteHandling: boolean
	position: number | undefined
	byteLength: number
}): CellScanPlan | null {
	if (init.columnScan !== "auto") return null
	if (init.rowDelimiter.length !== 1 || init.columnDelimiter.length !== 1) return null

	const row = init.rowDelimiter[0]!
	const column = init.columnDelimiter[0]!

	// ASCII only: a single byte above 0x7F can split a UTF-8 sequence, which would break the unit count.
	if (row > 0x7f || column > 0x7f) return null
	if (row === column) return null
	if (row === CARRIAGE_RETURN || column === CARRIAGE_RETURN) return null
	if (init.enableQuoteHandling && (row === DOUBLE_QUOTE || column === DOUBLE_QUOTE)) return null
	if (init.position !== undefined && init.position !== 0) return null
	if (init.byteLength > MAX_CELL_SCAN_BYTES) return null

	return { rowDelimiter: row, columnDelimiter: column }
}

const fatalDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/**
 * Decode the whole source for slicing. `null` means invalid UTF-8, the one failure the fast path defers to the row
 * path on. Any other error propagates.
 */
export function decodeForCellScan(bytes: Uint8Array): string | null {
	try {
		return fatalDecoder.decode(bytes)
	} catch (error) {
		if (error instanceof TypeError) return null

		throw error
	}
}
```

- [ ] **Step 4: Add the option and the branch in `CSVSpliterator.ts`**

Add to `CSVSpliteratorInit` after `trim`:

```ts
	/**
	 * How columns are found. `"auto"` scans every cell of a wholly in-memory source in one SIMD pass and slices the
	 * decoded text, and otherwise uses `"rows"`. `"rows"` decodes and splits each row, as every version before 7.20
	 * did. Both produce the same values.
	 *
	 * The bulk path decodes the whole source on the first pull, even for `take(1)`, and a retained cell may keep the
	 * whole decoded string alive. Use `"rows"` to avoid either cost.
	 *
	 * @default "auto"
	 */
	columnScan?: "auto" | "rows"
```

Add imports: `normalizeCharacterInput` from `../core/CharacterSequence.js`; `cellScanEligibility, decodeForCellScan, scanCsvCells` from `./csv-cells.js`.

In `splitRows`, destructure `columnScan = "auto"` alongside `trim = true`. After `const columnDelimiter = new CharacterSequence(...)`, before `const rows = Spliterator.fromSync(...)`, insert the fast branch. It must not touch `source` until first pull, which is already true because `splitRows` is a generator:

```ts
const bytes = normalizeCharacterInput(source)
const rowDelimiter = new CharacterSequence(rowInit.delimiter ?? Delimiters.LineFeed)
const plan = cellScanEligibility({
	columnScan,
	rowDelimiter,
	columnDelimiter,
	enableQuoteHandling,
	position: rowInit.position,
	byteLength: bytes.byteLength,
})
// The scanner loads asynchronously; a synchronous caller sees it only if something awaited `whenReady()` first.
const text = plan && CharacterSequence.hasScanner() ? decodeForCellScan(bytes) : null

if (plan && text !== null) {
	const cellRows = scanCsvCells(bytes, text, {
		rowDelimiter: plan.rowDelimiter,
		columnDelimiter: plan.columnDelimiter,
		enableQuoteHandling,
		crlf,
		trim,
		skipEmpty: rowInit.skipEmpty ?? true,
	})

	if (header) {
		const result = cellRows.next()

		if (result.done) return

		const headers = normalizeKeys ? normalizeColumnNames(result.value) : result.value

		transformers = bindTransformers(headers, transformersInput)
	}

	for (const columns of cellRows) {
		if (yieldCount < drop) {
			yieldCount++

			continue
		}

		if (yieldCount >= yieldLimit) break

		yield emitter ? emitter(columns, transformers) : columns

		yieldCount++
	}

	return
}
```

Pass `bytes` rather than `source` to `Spliterator.fromSync` below it so the normalization is done once.

`CharacterSequence.hasScanner()` does not exist yet. Add it next to `whenReady`:

```ts
	/**
	 * Whether the SIMD scanner is loaded right now. A synchronous caller uses this to choose a path without awaiting.
	 */
	public static hasScanner(): boolean {
		return Boolean(CharacterSequence.#wasmScanner)
	}
```

`Spliterator` builds its needle as `new CharacterSequence(init.delimiter)`, and `CharacterSequence`'s constructor defaults an undefined input to `Delimiters.LineFeed`; `rowInit.delimiter ?? Delimiters.LineFeed` mirrors that.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn test --run test/formats/CSVSpliterator.test.ts -t "columnScan"`
Expected: PASS.

If "transformers ... behave the same" reports differing call counts, the header row was double-consumed: confirm the fast branch reads the header from `cellRows` and not from `rows`. If the eligibility table's "nonzero position" case fails, confirm `position` is read from `rowInit` and not stripped earlier.

- [ ] **Step 6: Lint, full suite, commit**

Run: `yarn lint:fix && yarn lint && yarn test --run`
Expected: lint prints nothing; all tests pass. The full suite is the broad parity check: every existing CSV test now runs the fast path by default wherever `whenReady` was awaited.

```bash
git add lib/formats/CSVSpliterator.ts lib/formats/csv-cells.ts lib/core/CharacterSequence.ts test/formats/CSVSpliterator.test.ts
git commit -m "CSVSpliterator.from: columnScan auto takes the bulk cell scan when eligible"
```

---

### Task 5: Adaptive-source bulk parser hook

**Files:**

- Modify: `lib/io/adaptive-source.ts`
- Test: `test/io/adaptive-source.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces:

```ts
/**
 * Parses the whole in-memory source when the bulk branch is taken. Awaited after `CharacterSequence.whenReady()`.
 */
export type BulkParser<R> = (bytes: Uint8Array, init: AdaptiveSourceInit) => Iterable<R>

export async function openDelimitedRows<R = Uint8Array>(
	source: AsyncDataResource | AsyncChunkIterator,
	init?: AdaptiveSourceInit,
	bulkParser?: BulkParser<R>
): Promise<AsyncIterable<Uint8Array> | Iterable<Uint8Array | R>>
```

With no `bulkParser`, behavior is unchanged (`Spliterator.fromSync`). With one, every bulk branch (sized file at or below the threshold; empty stream; single exhausted chunk at or below the threshold) returns `bulkParser(bytes, init)`. The streaming branch never calls it.

- [ ] **Step 1: Write the failing tests**

Add to `test/io/adaptive-source.test.ts`:

```ts
describe("bulk parser hook", () => {
	const encoder = new TextEncoder()
	const marker = (bytes: Uint8Array) => [`bulk:${bytes.byteLength}`]

	test("a sized source at or below the threshold is handed to the bulk parser whole", async () => {
		const rows = await openDelimitedRows(csvPath, BULK, marker)

		expect(Array.from(rows as Iterable<string>)).toEqual([`bulk:${(await fs.stat(csvPath)).size}`])
	})

	test("a sized source above the threshold streams and never calls the bulk parser", async () => {
		let calls = 0
		const rows = await openDelimitedRows(csvPath, { bulkThreshold: 16 }, (bytes) => {
			calls++

			return marker(bytes)
		})

		expect(Symbol.asyncIterator in rows).toBe(true)
		expect(calls).toBe(0)
	})

	test("an empty stream and a single exhausted chunk take the bulk parser; two chunks stream", async () => {
		const bytes = encoder.encode("a,b\nc,d\n")

		expect(
			Array.from((await openDelimitedRows(chunkedSource(new Uint8Array(0), 4), BULK, marker)) as Iterable<string>)
		).toEqual(["bulk:0"])
		expect(Array.from((await openDelimitedRows(chunkedSource(bytes, 1024), BULK, marker)) as Iterable<string>)).toEqual(
			["bulk:8"]
		)

		const streamed = await openDelimitedRows(chunkedSource(bytes, 4), BULK, marker)

		expect(Symbol.asyncIterator in streamed).toBe(true)
	})

	test("a single chunk above the threshold streams", async () => {
		const bytes = encoder.encode("a,b\nc,d\n")
		const streamed = await openDelimitedRows(chunkedSource(bytes, 1024), { bulkThreshold: 4 }, marker)

		expect(Symbol.asyncIterator in streamed).toBe(true)
	})

	test("bulkThreshold: 0 streams even with a bulk parser", async () => {
		const streamed = await openDelimitedRows(csvPath, STREAMING, marker)

		expect(Symbol.asyncIterator in streamed).toBe(true)
	})

	test("the bulk parser is called after the scanner is ready", async () => {
		let ready = false
		await openDelimitedRows(csvPath, BULK, (bytes) => {
			ready = CharacterSequence.hasScanner()

			return marker(bytes)
		})

		expect(ready).toBe(true)
	})
})
```

Add `CharacterSequence` to the spliterator import in that file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test --run test/io/adaptive-source.test.ts -t "bulk parser hook"`
Expected: FAIL; the third argument is ignored, so rows are `Uint8Array`s, not marker strings.

- [ ] **Step 3: Implement the hook**

In `lib/io/adaptive-source.ts`, add the type after `AdaptiveSourceInit`:

```ts
/**
 * Parses a wholly in-memory source on the bulk branch, after {@linkcode CharacterSequence.whenReady} has resolved.
 * `CSVSpliterator` passes the cell scan here; the default is the synchronous row engine.
 */
export type BulkParser<R> = (bytes: Uint8Array, init: AdaptiveSourceInit) => Iterable<R>
```

Change `bulk` to take and use it:

```ts
async function bulk<R>(
	bytes: Uint8Array,
	init: AdaptiveSourceInit,
	bulkParser?: BulkParser<R>
): Promise<Iterable<Uint8Array | R>> {
	await CharacterSequence.whenReady()

	return bulkParser ? bulkParser(bytes, init) : Spliterator.fromSync(bytes, init)
}
```

Thread the parameter through `openDelimitedRows<R = Uint8Array>(source, init = {}, bulkParser?: BulkParser<R>)` and `openChunkIterator(source, threshold, init, bulkParser)`, passing it to every `bulk(...)` call and widening the two return types to `Promise<AsyncIterable<Uint8Array> | Iterable<Uint8Array | R>>`. The streaming returns are untouched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test --run test/io/adaptive-source.test.ts`
Expected: PASS, including every pre-existing pair test (the default path is unchanged).

- [ ] **Step 5: Lint, full suite, commit**

Run: `yarn lint:fix && yarn lint && yarn test --run`
Expected: lint prints nothing; all tests pass. `TextSpliterator`, `JSONSpliterator`, `count`, `countAsync` compile unchanged against the widened signature because they never pass a parser and the default `R` is `Uint8Array`.

```bash
git add lib/io/adaptive-source.ts test/io/adaptive-source.test.ts
git commit -m "openDelimitedRows: optional bulk parser for the whole-source branch"
```

---

### Task 6: The async bulk path (`CSVSpliterator.fromAsync`)

**Files:**

- Modify: `lib/formats/CSVSpliterator.ts` (`fromAsync`)
- Test: `test/formats/CSVSpliterator.test.ts`

**Interfaces:**

- Consumes: `openDelimitedRows(source, init, bulkParser)` (Task 5); `cellScanEligibility`, `decodeForCellScan`, `scanCsvCells` (Tasks 3–4).
- Produces: no new exports. `fromAsync`'s row op accepts `Uint8Array | string[]`: a `string[]` is already split cells from the bulk parser; a `Uint8Array` is a row from the streaming engine or the row-path fallback.

- [ ] **Step 1: Write the failing tests**

Add to the `describe("columnScan", ...)` block from Task 4:

```ts
test("the async bulk branch takes the fast path and matches streaming and rows", async ({ expect }) => {
	const spy = vi.spyOn(CharacterSequence, "scanCells")
	const auto = await CSVSpliterator.fromAsync(fixturePath).toArray()

	expect(spy).toHaveBeenCalled()
	spy.mockClear()

	const rows = await CSVSpliterator.fromAsync(fixturePath, { columnScan: "rows" }).toArray()
	const streamed = await CSVSpliterator.fromAsync(fixturePath, { bulkThreshold: 0 }).toArray()

	expect(spy).not.toHaveBeenCalled()
	spy.mockRestore()

	expect(auto).toEqual(rows)
	expect(auto).toEqual(streamed)
})

test("an unsized single-chunk stream takes the fast path; a multi-chunk stream does not", async ({ expect }) => {
	const encoder = new TextEncoder()
	const bytes = encoder.encode("name,age\nAda,36\nBob,41\n")
	const one = async function* () {
		yield bytes
	}
	const many = async function* () {
		yield bytes.subarray(0, 10)
		yield bytes.subarray(10)
	}
	const spy = vi.spyOn(CharacterSequence, "scanCells")

	expect(await CSVSpliterator.fromAsync(one()).toArray()).toEqual([
		{ name: "Ada", age: "36" },
		{ name: "Bob", age: "41" },
	])
	expect(spy).toHaveBeenCalled()
	spy.mockClear()

	expect(await CSVSpliterator.fromAsync(many()).toArray()).toEqual([
		{ name: "Ada", age: "36" },
		{ name: "Bob", age: "41" },
	])
	expect(spy).not.toHaveBeenCalled()
	spy.mockRestore()
})

test("drop and take on the async bulk path keep fromAsync's callback order", async ({ expect }) => {
	const encoder = new TextEncoder()
	const source = async function* () {
		yield encoder.encode("n\n1\n2\n3\n4\n")
	}
	const seen: string[] = []
	const out = await CSVSpliterator.fromAsync(source(), {
		drop: 1,
		take: 2,
		transformers: {
			n: (v) => {
				seen.push(v)
				return Number(v)
			},
		},
	}).toArray()

	expect(out).toEqual([{ n: 2 }, { n: 3 }])
	// fromAsync maps before it drops, so the dropped row's transformer still ran, as it does today.
	expect(seen).toEqual(["1", "2", "3"])
})

test("take(0) leaves a deferred async source unopened", async ({ expect }) => {
	let opened = false
	const source = {
		async *[Symbol.asyncIterator]() {
			opened = true
			yield new TextEncoder().encode("a,b\n1,2\n")
		},
	}

	expect(await CSVSpliterator.fromAsync(source, { header: false, mode: "array" }).take(0).toArray()).toEqual([])
	expect(opened).toBe(false)
})

test("invalid UTF-8 on the async bulk path falls back to rows", async ({ expect }) => {
	const source = async function* () {
		yield new Uint8Array([0x61, 0x2c, 0xff, 0x0a])
	}
	const spy = vi.spyOn(CharacterSequence, "scanCells")

	expect(await CSVSpliterator.fromAsync(source(), { header: false, mode: "array" }).toArray()).toEqual([["a", "�"]])
	expect(spy).not.toHaveBeenCalled()
	spy.mockRestore()
})

test("a throwing transformer on the bulk path propagates once", async ({ expect }) => {
	let calls = 0
	let closed = false
	const source = {
		async *[Symbol.asyncIterator]() {
			try {
				yield new TextEncoder().encode("a,b\n1,2\n3,4\n")
			} finally {
				closed = true
			}
		},
	}

	await expect(
		CSVSpliterator.fromAsync(source, {
			transformers: {
				a: () => {
					calls++
					throw new Error("boom")
				},
			},
		}).toArray()
	).rejects.toThrow("boom")
	expect(calls).toBe(1)
	expect(closed).toBe(true)
})

test("TSV and PSV inherit the fast path through their column delimiter", async ({ expect }) => {
	const spy = vi.spyOn(CharacterSequence, "scanCells")
	const source = async function* () {
		yield new TextEncoder().encode("a\tb\n1\t2\n")
	}

	expect(await TSVSpliterator.fromAsync(source(), { header: false, mode: "array" }).toArray()).toEqual([
		["a", "b"],
		["1", "2"],
	])
	expect(spy).toHaveBeenCalled()
	spy.mockRestore()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test --run test/formats/CSVSpliterator.test.ts -t "async bulk|unsized single-chunk|drop and take on the async|leaves a deferred|invalid UTF-8 on the async|throwing transformer|TSV and PSV inherit"`
Expected: FAIL; the spy is never called on the bulk branch.

- [ ] **Step 3: Implement**

In `fromAsync`, destructure `columnScan = "auto"` with the other options. Replace the body from `const openRows = ...` to the end with:

```ts
const rowDelimiter = new CharacterSequence(rowInit.delimiter ?? Delimiters.LineFeed)
const skipEmpty = rowInit.skipEmpty ?? true

/**
 * The bulk branch: eligibility, then the fatal decode as the last gate. Invalid UTF-8 hands the same bytes to
 * the row engine, which the map op below still understands. Runs after `whenReady`, on the first pull.
 */
const bulkParser = (bytes: Uint8Array): Iterable<Uint8Array | string[]> => {
	const plan = cellScanEligibility({
		columnScan,
		rowDelimiter,
		columnDelimiter,
		enableQuoteHandling,
		position: rowInit.position,
		byteLength: bytes.byteLength,
	})
	const text = plan && CharacterSequence.hasScanner() ? decodeForCellScan(bytes) : null

	if (!plan || text === null) {
		return Spliterator.fromSync(bytes, { ...rowInit, crlf, enableQuoteHandling })
	}

	return scanCsvCells(bytes, text, {
		rowDelimiter: plan.rowDelimiter,
		columnDelimiter: plan.columnDelimiter,
		enableQuoteHandling,
		crlf,
		trim,
		skipEmpty,
	})
}

const toColumns = (row: Uint8Array | string[]): string[] =>
	Array.isArray(row) ? row : splitRowColumns(row, columnDelimiter, decoder, enableQuoteHandling, trim)

const openRows = async (): Promise<AsyncIterable<Uint8Array> | Iterable<Uint8Array | string[]>> => {
	// Quote handling applies at both levels: rows must not split on newlines inside quotes,
	// columns must not split on quoted column delimiters.
	const rows = await openDelimitedRows(source, { ...rowInit, crlf, enableQuoteHandling }, bulkParser)

	if (header) {
		// Both engines return `this` from their iterator method. Consuming the header row here advances the cursor the
		// row ops will read. Returning `rows` afterwards resumes at row two rather than row one.
		const iterator = Symbol.asyncIterator in rows ? rows[Symbol.asyncIterator]() : rows[Symbol.iterator]()
		const result = await iterator.next()

		if (result.done) return rows

		const columns = toColumns(result.value)
		const headers = normalizeKeys ? normalizeColumnNames(columns) : columns

		transformers = bindTransformers(headers, transformersInput)
	}

	return rows
}

let sequence: AsyncSequence<unknown> = AsyncSequence.from<Uint8Array | string[]>(openRows).map((row) => {
	const columns = toColumns(row)

	return emitter ? emitter(columns, transformers) : columns
})

if (drop > 0) {
	sequence = sequence.drop(drop)
}

if (Number.isFinite(take)) {
	sequence = sequence.take(take)
}

return sequence
```

The generator returned by `scanCsvCells` returns `this` from `[Symbol.iterator]()`, so the header consumption above advances it exactly as it advances `Spliterator`. `Spliterator.fromSync` here receives the same `rowInit` the default parser would have received; `openDelimitedRows` passes `init` to the parser, but the CSV parser closes over its own options and ignores that argument.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test --run test/formats/CSVSpliterator.test.ts`
Expected: PASS.

If "take(0) leaves a deferred async source unopened" fails, the eligibility or decode ran eagerly: confirm nothing in `fromAsync` touches `source` outside `openRows`. If "a throwing transformer ... propagates once" reports `closed: false`, the header path threw before `AsyncSequence` had the iterator to close: check that `openRows` wraps the header read so the row iterable's `return()` runs on throw (a `try { ... } catch (error) { await iterator.return?.(); throw error }` around the header block), and add that if it is missing.

- [ ] **Step 5: Lint, full suite, commit**

Run: `yarn lint:fix && yarn lint && yarn test --run`
Expected: lint prints nothing; all tests pass.

```bash
git add lib/formats/CSVSpliterator.ts test/formats/CSVSpliterator.test.ts
git commit -m "CSVSpliterator.fromAsync: the bulk branch takes the cell scan"
```

---

### Task 7: Benchmark, default gate, docs

**Files:**

- Create: `benchmarks/csv-column-scan.ts`
- Modify: `AGENTS.md` (architecture entry for CSV, gotchas, exports section unchanged)
- Modify: `README.md` if it documents CSV options (check with `grep -n "enableQuoteHandling" README.md`)

**Interfaces:**

- Consumes: the finished feature.
- Produces: numbers in AGENTS.md; the decision on the default.

- [ ] **Step 1: Write the benchmark**

Create `benchmarks/csv-column-scan.ts`, following `benchmarks/csv-columns.ts`'s header and usage comment (`node out/benchmarks/csv-column-scan.js`):

```ts
/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 * Benchmark: columnScan "auto" (one decode, one kernel pass, sliced cells) against "rows" (decode and split per row).
 * Usage: node out/benchmarks/csv-column-scan.js
 *
 * Fixtures are generated in memory and written to the OS temp directory so the async path reads real files. Prints
 * Node, CPU, revision, and min/median of the repetitions; peak RSS is sampled around each run.
 */

import { execSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { cpus } from "node:os"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { CharacterSequence, CSVSpliterator } from "../index.js"

const REPS = 7
const encoder = new TextEncoder()

function csv(rows: number, quoted: boolean, unicode: boolean): Uint8Array {
	const lines = ["id,name,city,state,zip"]

	for (let i = 0; i < rows; i++) {
		const name =
			quoted && i % 4 === 0
				? `"Lovelace, Ada ""${i}"""`
				: unicode && i % 3 === 0
					? `Ada Lovelacé 한 😀 ${i}`
					: `Ada Lovelace ${i}`

		lines.push(`${i},${name},London,LDN,${10000 + (i % 90000)}`)
	}

	return encoder.encode(lines.join(quoted ? "\r\n" : "\n") + "\n")
}

async function time(label: string, fn: () => Promise<unknown> | unknown): Promise<void> {
	await fn()

	const samples: number[] = []
	let peak = 0

	for (let i = 0; i < REPS; i++) {
		const before = process.memoryUsage().rss
		const start = process.hrtime.bigint()

		await fn()
		samples.push(Number(process.hrtime.bigint() - start) / 1e6)
		peak = Math.max(peak, process.memoryUsage().rss - before)
	}

	samples.sort((a, b) => a - b)
	console.log(
		label.padEnd(56),
		`min ${samples[0]!.toFixed(1).padStart(7)} ms`,
		`median ${samples[Math.floor(REPS / 2)]!.toFixed(1).padStart(7)} ms`,
		`rss +${(peak / 1024 / 1024).toFixed(0).padStart(4)} MB`
	)
}

const revision = execSync("git rev-parse --short HEAD").toString().trim()
console.log(`node ${process.version}, ${cpus()[0]?.model ?? "unknown cpu"}, spliterator ${revision}, ${REPS} reps\n`)

await CharacterSequence.whenReady()

const dir = mkdtempSync(join(tmpdir(), "spliterator-csv-"))
const fixtures = {
	"1M plain": csv(1_000_000, false, false),
	"1M quoted crlf": csv(1_000_000, true, false),
	"1M unicode": csv(1_000_000, false, true),
	"2K (under bulk threshold)": csv(2_000, false, false),
	"8K (under bulk threshold)": csv(8_000, false, false),
}

for (const [name, bytes] of Object.entries(fixtures)) {
	const path = join(dir, name.replaceAll(/\W+/g, "-") + ".csv")

	writeFileSync(path, bytes)
	console.log(`— ${name}: ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB`)

	for (const columnScan of ["rows", "auto"] as const) {
		for (const mode of ["array", "object", "entries"] as const) {
			let n = 0

			await time(`sync  ${mode.padEnd(7)} ${columnScan}`, () => {
				for (const row of CSVSpliterator.from(bytes, { mode, columnScan } as never)) n += (row as unknown[]).length
			})
		}

		let n = 0

		await time(`async object  ${columnScan}`, async () => {
			for await (const row of CSVSpliterator.fromAsync(path, { columnScan })) n += Object.keys(row).length
		})
		await time(`sync  first row only ${columnScan}`, () => {
			for (const _row of CSVSpliterator.from(bytes, { columnScan })) break
		})
		await time(`sync  array trim:false ${columnScan}`, () => {
			for (const row of CSVSpliterator.from(bytes, { mode: "array", trim: false, columnScan } as never)) n += row.length
		})
		void n
	}

	console.log()
}
```

- [ ] **Step 2: Run it and record the numbers**

Run: `yarn compile && node out/benchmarks/csv-column-scan.js`
Expected: a table per fixture. Record it in the commit message body and in AGENTS.md.

Decision rule from the spec: keep `"auto"` as the default if `auto` beats `rows` on the 1M fixtures for every mode, and the "first row only" and under-threshold rows are not materially worse (within ~2× on first-row for the 1M fixtures, and within noise on the 2K/8K fixtures). If the rule fails, change the default in `CSVSpliteratorInit`, `splitRows` and `fromAsync` to `"rows"`, update the option's JSDoc `@default`, and open the result as the last section of the spec.

- [ ] **Step 3: Document**

In `AGENTS.md`:

Under the `CSVSpliterator` bullet in "High-level spliterators", append:

> **`columnScan: "auto"`** (default) parses a wholly in-memory source by decoding it once with a `fatal` decoder and slicing cells at boundaries the `scan_csv_cells` kernel emits in UTF-16 units; `"rows"` is the per-row path and the parity reference. `lib/formats/csv-cells.ts` drives the kernel in 64 KiB windows; `cellScanEligibility` lists the gates (single ASCII delimiters that differ, no CR delimiter, no `position`, under the string length cap, scanner loaded, valid UTF-8). The async path reaches it through the `bulkParser` argument of `openDelimitedRows`, so only sources the adaptive source reads whole take it. Measured on a 1M-row, 5-column file: `<numbers from Step 2>`.

Under "Non-obvious Gotchas", add:

> - **`scan_csv_cells` counts UTF-16 units from the UTF-8 lead byte, which is only exact for valid UTF-8**: the fast path decodes with `{ fatal: true, ignoreBOM: true }` and treats the decoder's `TypeError` as "take the row path". Decoding lossily would silently misalign every cell after the first bad byte. `ignoreBOM` is required too: the row path strips one BOM per row because it decodes per row, so `csv-cells.ts` strips it per row itself.
> - **Kernel result views alias shared memory**: `CharacterSequence.scanCells` copies each batch out before returning, because a transformer may run a nested parse while the outer row is being assembled. Don't "optimize" the copy away.

Update the module doc comment at the top of `csv-columns.ts` ("Decode the row once" section) with one sentence pointing at `csv-cells.ts` as the path a whole buffer takes, so the measurements there are read in context.

Add a README note only if README already lists CSV options.

- [ ] **Step 4: Lint, full suite, commit**

Run: `yarn lint:fix && yarn lint && yarn test --run`
Expected: lint prints nothing; all tests pass.

```bash
git add benchmarks/csv-column-scan.ts AGENTS.md lib/formats/csv-columns.ts README.md
git commit -m "CSV bulk cell scan: benchmark, docs, default decision

<paste the benchmark table>"
```

---

## Self-review notes

- Spec coverage: kernel (T1), wrapper and batch ownership (T2), generator with BOM/CRLF/skipEmpty/quotes/trim/tail rules (T3), eligibility conditions 1–8 and the sync path with the isolated-process scanner test (T4), adaptive hook (T5), async path with laziness, `take(0)`, error propagation, TSV/PSV (T6), benchmark and default gate and docs (T7). `count`/`countAsync` untouched by construction.
- Names used across tasks: `scanCsvCells`, `CsvCellScanInit`, `cellScanEligibility`, `CellScanPlan`, `decodeForCellScan`, `MAX_CELL_SCAN_BYTES`, `CELL_SCAN_WINDOW` (csv-cells); `normalizeCell`, `unquoteColumn`, `DOUBLE_QUOTE_CODE` (csv-columns); `CharacterSequence.scanCells`, `hasScanner`, `CellScanState`, `CellScanOptions`; `WasmCellScanResult`, `CELL_RESULT_HEADER`, `CELL_RESULT_STRIDE`, `CELL_FLAG_ROW_END`, `CELL_FLAG_HAS_QUOTE` (wasm_module); `BulkParser`, `openDelimitedRows(source, init, bulkParser)` (adaptive-source).
- Review Focus items 1–4 are pinned in Task 3; item 5 in Task 6.
