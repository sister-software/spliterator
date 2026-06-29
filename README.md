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
