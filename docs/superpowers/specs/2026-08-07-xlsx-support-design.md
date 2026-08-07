# XLSX Support — Design

**Date:** 2026-08-07
**Status:** Approved approach; pending implementation

## Goal

Read and write `.xlsx` workbooks through spliterator's existing API idioms: a static
`XLSXSpliterator` class whose reader mirrors `CSVSpliterator`'s option surface and returns an
`AsyncSequence`, and a writer that accepts any iterable or async iterable of rows — so an
`AsyncSequence` pipeline (e.g. one fed by `CSVSpliterator.fromAsync`) terminates naturally in an
XLSX file.

## Vendor choice

`read-excel-file` (^9.3.7) and `write-excel-file` (^4.1.1) replace the previously chosen `xlsx`
(SheetJS) peer dependency. Rationale:

- ESM-first, typed, minimal dependency trees (`fflate`/`unzipper-esm` for ZIP, `saxen` for XML),
  Node ≥ 18, proper subpath exports (`/node`, `/browser`, `/universal`).
- The npm `xlsx@0.18.5` build is stale (SheetJS moved distribution off npm) and carries known
  CVEs.
- Cells arrive **typed** (`string | number | boolean | Date | null`) rather than as strings —
  a better fit for XLSX than a CSV round-trip.

Both are **optional peer dependencies**, loaded via dynamic `import()` inside the methods that
need them (the same isomorphism pattern `node/fs` uses). A missing module produces a clear error
naming the package to install.

## Constraint accepted: whole-workbook-in-memory

XLSX is a ZIP archive of XML parts; shared strings live in a separate archive entry, and both
vendor libraries materialize whole sheets. `XLSXSpliterator` therefore does **not** honor the
bounded-memory streaming promise of the byte-level engines, in either direction. This is
documented in the class JSDoc and AGENTS.md. A true streaming XLSX engine (Approach C in
brainstorming) is out of scope.

## Class shape

`XLSXSpliterator` is a **standalone** abstract static class — it does *not* extend
`CSVSpliterator`. None of the byte-splitting machinery applies (the inherited `from` would
newline-split ZIP bytes), and inherited options (`columnDelimiter`, `enableQuoteHandling`,
`crlf`, `position`) are meaningless for XLSX. The constructor throws `TypeError`, matching the
other static classes.

### Reader — `XLSXSpliterator.fromAsync(source, init)`

```ts
type XLSXCellValue = string | number | boolean | Date | null

interface XLSXSpliteratorInit {
	/** Sheet number (1-based) or name. @default 1 */
	sheet?: number | string
	/** Output shape, as in CSVSpliterator. @default "array" */
	mode?: CSVOutputMode
	/** Treat the first row as a header. @default true */
	header?: boolean
	/** Normalize header keys. @default mode !== "array" (matches CSVSpliterator) */
	normalizeKeys?: boolean
	/** Per-column transformers; receive typed cell values, not strings. */
	transformers?: Iterable<XLSXTransformerEntry> | XLSXTransformerRecord
	drop?: number
	take?: number
}
```

- Returns `AsyncSequence<T>` with the same `mode`-driven overloads as
  `CSVSpliterator.fromAsync`: `"array"` → `XLSXCellValue[]`, `"object"` → record, `"entries"` →
  `RowTuple[]`.
- `source` accepts what the vendor accepts, adapted from spliterator's types: a path
  (`string`/`URL`), a `Uint8Array`/`Buffer`, or an `AsyncChunkIterator` (converted via
  `Stream.Readable.from`).
- Internally: `AsyncSequence.from(thunk)` where the thunk dynamically imports
  `read-excel-file/node`, calls `readSheet(input, sheet, ...)`, consumes the first row as the
  header when `header` is true, and yields the remaining rows through the shared emitter
  machinery. Nothing is read until the first pull, matching `fromAsync` semantics elsewhere.
- Header cells are stringified (`String(cell ?? "")`) before `normalizeColumnNames`, since a
  header row may legally contain numbers.
- `drop`/`take` compose as `AsyncSequence.drop/take`, exactly as `CSVSpliterator.fromAsync`
  does.

### No sync reader

`read-excel-file` is Promise-based end to end (async unzip, worker-capable XML parse), so a
faithful synchronous `from` is impossible. `XLSXSpliterator.from()` exists and **throws
`TypeError`** with a message directing callers to `fromAsync` — honest, discoverable, and
consistent with the static-class-throws idiom.

### Writer — `XLSXSpliterator.write(source, init)`

```ts
type XLSXWritableRow = readonly XLSXCellValue[] | Record<string, XLSXCellValue>

interface XLSXWriteInit {
	/** Sheet name. */
	sheet?: string
	/** Emit a header row. For record rows, defaults to true; for array rows, false. */
	header?: boolean
}

interface XLSXWriteHandle {
	toFile(path: string): Promise<void>
	toBuffer(): Promise<Buffer>
	toStream(writable?: NodeJS.WritableStream): Promise<unknown>
}

static write(source: Iterable<XLSXWritableRow> | AsyncIterable<XLSXWritableRow>, init?: XLSXWriteInit): XLSXWriteHandle
```

- `write` returns synchronously; each handle method **materializes the source on first
  invocation** (rows must be complete before `write-excel-file` can build the archive), then
  delegates to `writeXlsxFile(...)`'s corresponding method.
- Array rows pass through as-is — `write-excel-file` accepts bare
  `string | number | boolean | Date | null` cells and infers types.
- Record rows: the header row is derived from the **first record's keys** (YAGNI: no key-union
  scan); subsequent records are read in that key order, missing keys become `null`.
- `RowTuple[]` / entries input is **not** supported in v1.
- Cell styling, formats, column widths, formulas, and multi-sheet workbooks are out of scope.

## Shared emitter extraction

The header/transformer/emitter machinery currently private to `CSVSpliterator` moves to a new
`lib/row-emitters.ts`, generalized over cell type `V` (CSV binds `string`, XLSX binds
`XLSXCellValue`):

- `identity`, the `entries` and `object` emitters (currently `CSVSpliteratorEmitters`), and the
  transformer-binding logic (the `Array.isArray(transformersInput)` / record branch duplicated
  in `from` and `fromAsync`).
- `CSVSpliterator` re-exports what it currently exports publicly (`CSVSpliteratorEmitters`,
  `CSVTransformer*` types) so its surface is unchanged; existing CSV parity tests must pass
  untouched.

## Package changes

- `peerDependencies` / `peerDependenciesMeta`: remove `xlsx`; add `read-excel-file` and
  `write-excel-file`, both optional.
- `devDependencies`: same swap, so tests can exercise the real modules.
- `index.ts` already exports `./lib/XLSXSpliterator.js`; keep it.

## Error handling

- Missing peer dep: the dynamic import is wrapped; on failure, throw
  `Error("XLSXSpliterator requires the optional peer dependency \"read-excel-file\" (or \"write-excel-file\" for write). Install it to use this API.")`
  with the original error as `cause`.
- Vendor errors (`InvalidSpreadsheetError`, `SheetNotFoundError`) propagate as-is.
- Early exit (`take`, `break`) is trivially safe: rows are already materialized; there is no
  file handle to release after the vendor resolves.

## Testing

Tests live in `test/XLSXSpliterator.test.ts`. The XLSX fixture is **generated in test setup via
`write-excel-file`** (a temp file), which makes the round-trip itself the foundation:

1. **Round-trip parity** — write records → read back with `mode: "object"` → deep-equal,
   including typed cells (number, boolean, `Date`).
2. **Reader modes** — `array` / `object` / `entries` shapes; `header: false`; `normalizeKeys`
   on and off; `drop`/`take`.
3. **Sheet selection** — by index and by name; unknown sheet propagates
   `SheetNotFoundError`.
4. **Transformers** — receive typed values (assert a `Date` reaches the transformer as `Date`).
5. **`from()` throws** — `TypeError` naming `fromAsync`.
6. **Writer shapes** — array rows with `header` option, record rows with missing keys →
   `null`, `toBuffer` and `toFile` targets.
7. **CSV emitter parity** — existing `CSVSpliterator` tests pass unchanged after the
   `row-emitters.ts` extraction.
