# Spliterator 🎀

Spliterator is a TypeScript library for streaming delimited content such as CSV, TSV and JSONL.

Let's say you have a huge newline-delimited JSON file that can't fit into memory:

```js
{"name": "Jessie", "age": 30}
{"name": "Kelly", "age": 40}
{"name": "Loren", "age": 50}
// Several hundred thousand more lines...
```

Spliterator can help you read it line-by-line without loading the entire file into memory:

```ts
import { JSONSpliterator } from "spliterator"

interface Person {
	name: string
	age: number
}

const reader = JSONSpliterator.fromAsync("example.jsonl")

for await (const line of reader) {
	console.log(line) // {"name": "Alice", "age": 30}, etc.
}
```

[![NPM Version](https://img.shields.io/npm/v/spliterator)](https://www.npmjs.com/package/spliterator)
![NPM License](https://img.shields.io/npm/l/spliterator)

# Installation

```bash
yarn add spliterator
# or
npm install spliterator
```

# Usage

## Character-delimited files

While Spliterator supports any delimited byte stream, it's particularly useful for character-delimited content such as comma-separated values (CSV), tab-separated values (TSV) – or any other delimiter you can think of.

```csv
Full Name, Occupation, Age
Morgan, Developer, 30
Nataly, Designer, 40
Orlando, Manager, 50
```

```ts
import { CSVSpliterator } from "spliterator"

const reader = CSVSpliterator.fromAsync("people.csv")

for await (const columns of reader) {
	console.log(columns) // ["Full Name", "Occupation", "Age"], ["Morgan", "Developer", 30], etc.
}
```

CSV files can also be emitted as objects with headers as keys, with some quality-of-life features, such as normalizing property keys:

```ts
import { CSVSpliterator } from "spliterator"

interface Person {
	full_name: string
	occupation: string
	age: number
}

const reader = CSVSpliterator.fromAsync<Person>("people.csv", { mode: "object" })

for await (const columns of reader) {
	console.log(columns) // { full_name: "Morgan", occupation: "Developer", age: 30 }, etc.
}
```

For tab-separated files, reach for `TSVSpliterator`. It accepts the same options as `CSVSpliterator` and defaults `columnDelimiter` to a tab, so you can omit it for the common case:

```ts
import { TSVSpliterator } from "spliterator"

const reader = TSVSpliterator.fromAsync("people.tsv", { mode: "object" })

for await (const columns of reader) {
	console.log(columns)
}
```

## Excel workbooks (XLSX)

Spliterator can read and write `.xlsx` workbooks through `XLSXSpliterator`. Support is powered by two optional peer dependencies — install the one you need:

```bash
yarn add read-excel-file  # for XLSXSpliterator.fromAsync
yarn add write-excel-file # for XLSXSpliterator.write
```

Reading mirrors `CSVSpliterator`'s options — `mode`, `header`, `normalizeKeys`, `transformers`, `drop`, and `take` — plus a `sheet` option to pick a sheet by 1-based number or name. Unlike CSV columns, XLSX cells arrive **typed**: numbers, booleans, and dates are real values rather than strings, and empty cells are `null`.

```ts
import { XLSXSpliterator } from "spliterator"

const reader = XLSXSpliterator.fromAsync("people.xlsx", { mode: "object", sheet: "Employees" })

for await (const row of reader) {
	console.log(row) // { full_name: "Morgan", hired: Date, age: 30 }, etc.
}
```

Transformers receive those typed cell values, which makes them a natural place to coerce loosely-exported data — many real-world workbooks store everything as text:

```ts
const reader = XLSXSpliterator.fromAsync("form499.xlsx", {
	mode: "object",
	transformers: {
		filer_499_id: (value) => Number(value),
		alabama: (value) => value === "TRUE",
	},
})
```

Writing accepts any iterable or async iterable of rows — arrays of cells, or records whose keys become the header row — so a Spliterator pipeline can terminate in a workbook:

```ts
const rows = CSVSpliterator.fromAsync("people.csv", { mode: "object" }).map((person) => ({
	...person,
	age: Number(person.age),
}))

await XLSXSpliterator.write(rows, { sheet: "People" }).toFile("people.xlsx")
```

A few caveats worth knowing:

- **The whole workbook is held in memory, in both directions.** XLSX is a ZIP archive of XML documents — shared strings live in a separate archive entry and the ZIP's central directory sits at the end of the file — so it cannot be parsed or produced as a bounded-memory stream the way delimited text can. Reading yields no rows until the entire sheet is parsed, and writing drains your source completely before producing bytes. Expect memory usage far above the file's size on disk (a 9 MB workbook can inflate to hundreds of MB parsed). For sources large enough that this matters, prefer CSV or JSONL.
- **There is no synchronous reader.** Decompression and XML parsing are asynchronous in the underlying reader, so `XLSXSpliterator.from()` always throws, pointing you to `fromAsync`.
- **One sheet at a time.** Reading targets a single sheet per call, and writing produces a single-sheet workbook. Cell styling, formats, and formulas are out of scope.

See `examples/xlsx-to-jsonl.ts` for a complete conversion script with derived transformers.

## CLI Usage

Spliterator also includes a CLI tool that can be used to stream delimited content from the command line, transform it, filter it, and more.

```bash
spliterator csv people.csv people.jsonl
```

The CLI also supports reading from standard input:

```bash
cat people.csv | spliterator csv people.jsonl
```

For information on all available commands, run `spliterator --help`.

## Advanced Usage

Spliterator includes a collection of low-level classes and interfaces that can be used to create custom generators for any kind of delimited content.

For more advanced usage, check out our tests in the `test` directory, or our fully-annotated source code.

### Reading from a stream

All included Spliterators implement the `Generator` and `AsyncGenerator` interfaces, so you can use them in `for...of` and `for await...of` loops, as well the web-native [ReadableStreams](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream), so you can use them in `for await...of` loops, as well as piping them through transformations to avoid nested and partially materialized streams.

```ts
import { JSONSpliterator } from "spliterator"

const people = [
	{ name: "Alice", age: 30 },
	{ name: "Bob", age: 40 },
	{ name: "Charlie", age: 50 },
]

const generator = JSONSpliterator.from(people.map(JSON.stringify).join("\n"))
const stream = ReadableStream.from(generator)

for await (const line of stream) {
	console.log(line) // {"name": "Alice", "age": 30}, etc.
}
```

### SIMD acceleration

Spliterator ships a small WebAssembly SIMD scanner that accelerates delimiter and quote scanning (roughly 5–6× over the JavaScript scanner for multi-byte delimiters, more for column splitting). It is embedded in the package — no extra files, fetches, or configuration.

The module loads **asynchronously**. Asynchronous parsing (`fromAsync`, streams) picks it up automatically once loaded. Purely synchronous parsing that finishes in a single tick would otherwise complete before the module is ready and transparently use the JavaScript scanner — to opt in, await it first:

```ts
import { CharacterSequence, CSVSpliterator } from "spliterator"

await CharacterSequence.whenReady() // resolves to true once the SIMD scanner is active

for (const row of CSVSpliterator.from(largeCsvString)) {
	// ...now backed by the SIMD scanner
}
```

Correctness is identical either way; `whenReady()` only affects which scanner runs.

## Choosing a primitive

The question that predicts the answer is not "how big is my file?" — it's **how much work happens per row.**

| Per-row work                                                 | What dominates | Reach for                                                                                           |
| ------------------------------------------------------------ | -------------- | --------------------------------------------------------------------------------------------------- |
| None — counting, segmenting, pulling a couple of fields      | The scan       | `Spliterator` raw byte ranges. The SIMD scanner earns its keep here (~5–6 GB/s vs ~600 MB/s for JS) |
| ~1–3 µs — `JSON.parse`, CSV → object, string normalize       | The parse      | Plain sequential `fromAsync`. Threads **lose** here (0.3–0.9×); JSONL runs ~0.5× of `readline`      |
| Milliseconds — model inference, geocoding, crypto, image ops | Your handler   | `parallelMapWorkers`, or `AsyncSpliterator.asManyWorkers` for one large file                        |
| I/O-bound — file fan-out, network                            | Latency        | `parallelMap` (caller's thread). Concurrency peaks around 2–3, then **degrades**                    |

The line worth internalizing: **the scan is almost never your bottleneck unless you aren't parsing.** Measure before adopting a parallel primitive.

The naming encodes one rule:

> **If you can pass a closure, it runs on your thread. If you must pass a module path, it runs on another one.**

Closures can't cross a `postMessage` boundary, so `parallelMap` takes a function and `parallelMapWorkers` takes a path — and `asMany`/`asManyWorkers` divide the same way.

|                       | Caller's thread             | Worker threads                   |
| --------------------- | --------------------------- | -------------------------------- |
| A collection of items | `parallelMap`               | `parallelMapWorkers`             |
| One large file        | `AsyncSpliterator.asMany`   | `AsyncSpliterator.asManyWorkers` |
| Just the boundaries   | `AsyncSpliterator.segments` | (feeds either)                   |

### Chaining

`fromAsync` returns an `AsyncSequence` — a lazy, chainable async iterator whose core methods (`map`, `filter`, `take`, `drop`, `flatMap`, `reduce`, `toArray`, `forEach`, `some`, `every`, `find`) match the [async iterator helpers proposal][helpers] in name and semantics. No polyfill required.

[helpers]: https://github.com/tc39/proposal-async-iterator-helpers

```ts
const cakes = await JSONSpliterator.fromAsync<Row>("menu.jsonl", { delimiter: "\n" })
	.filter((row) => row.category === "Ice Cream Cake")
	.map((row) => row.item_name)
	.take(10)
	.toArray()
```

Filtering happens while streaming, and `take(10)` closes the file handle instead of reading the rest. The operators fuse into a single pass rather than nesting one async generator per step, so chain depth is nearly free — doubling the operator count costs about 10%, where nesting would roughly double it. `flatMap`, `chunks`, and `parallelMap` are the exceptions, since they need inner-iterator state.

The synchronous `from` returns a plain generator, which already has the same helpers natively on Node 24+.

### Small sources are read whole

Opening a file handle and standing up a read stream costs about 100µs, which is most of the work for a small file. So `fromAsync` reads sources of 128 KiB or less into memory and parses them synchronously — measured ~1.85× faster at 635 B and ~1.4× at 125 KiB. Output is identical either way.

The threshold is deliberately small. Above ~256 KiB the advantage stops being measurable, while the memory cost keeps growing — a 1 GiB file costs ~105 MB resident streamed against ~1.1 GB read whole. Raising it buys nothing and spends memory linearly.

```ts
// Force streaming, whatever the size — when a bounded footprint is the point.
JSONSpliterator.fromAsync("data.jsonl", { delimiter: "\n", bulkThreshold: 0 })
```

Sources with no knowable length (a pipe, a `ReadableStream`) get an end-of-input test instead: if the first chunk read is also the last, the whole input is already in memory and is parsed directly. Otherwise it streams as normal.

### Parallel parsing across threads

For one large file with a CPU-bound per-row transform, `AsyncSpliterator.asManyWorkers` splits the file into delimiter-aligned segments and runs a handler module across worker threads — each worker owns its own handle and reads only its segment. Results stream back to the main thread as a single async iterator, for a single-thread writer (a database, a JSONL file).

```ts
import { AsyncSpliterator } from "spliterator"

// transform.js (runs in each worker; top-level code is per-worker init):
//   const dec = new TextDecoder(), enc = new TextEncoder()
//   export function handleRecord(bytes) {
//     return enc.encode(JSON.stringify(parse(dec.decode(bytes))) + "\n") // Uint8Array → zero-copy
//   }

for await (const jsonLine of AsyncSpliterator.asManyWorkers<Uint8Array>("huge.csv", {
	worker: new URL("./transform.js", import.meta.url),
	delimiter: "\n",
	concurrency: 8,
})) {
	out.write(jsonLine) // single-thread writer on main
}
```

Need just the byte ranges to drive your own pool? `AsyncSpliterator.segments(path, { delimiter, concurrency })` returns them.

### Custom generators

While Spliterator includes premade exports for most use-cases, custom generators can be created via `Spliterator` and `AsyncSpliterator`. This class is a low-level interface that allows you to create your own generators for any kind of delimited content.

# License

Spliterator is licensed under the AGPL-3.0 license. Generally,
this means that you can use the software for free, but you must share
any modifications you make to the software.

For more information on commercial usage licensing, please contact us at
`hello@sister.software`
