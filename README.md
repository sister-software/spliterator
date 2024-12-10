# What is Ribbon?

Ribbon makes newline-delimited files easy to work with.

Let's say you have a huge newline-delimited JSON file that can't fit into memory.

```js
{"name": "Jessie", "age": 30}
{"name": "Kelly", "age": 40}
{"name": "Loren", "age": 50}
// Several hundred thousand more lines...
```

Ribbon can help you read it line-by-line:

```ts
import { LineReader } from "@sister.software/ribbon"

const reader = new LineReader("example.ndjson")

for await (const line of reader) {
	console.log(line.toString()) // {"name": "Alice", "age": 30}, etc.
}
```

[![NPM Version](https://img.shields.io/npm/v/%40sister.software%2Fribbon)](https://www.npmjs.com/package/@sister.software/ribbon)

# Installation

```bash
yarn add @sister.software/ribbon
# or
npm install @sister.software/ribbon
```

# Usage

## Character-delimited files

While Ribbon supports any line-delimited file, it's particularly useful for character-delimited content such as comma-separated values (CSV), tab-separated values (TSV) – or any other delimiter you can think of.

```csv
Full Name, Occupation, Age
Morgan, Developer, 30
Nataly, Designer, 40
Orlando, Manager, 50
```

LineReaders extend web-native [ReadableStreams](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream), so you can use them in `for await...of` loops, as well as piping them through transformations to avoid nested and partially materialized streams.

```ts
import { LineReader, DelimiterTransformer, Delimiter } from "@sister.software/ribbon"

const reader = new LineReader(fileHandle).pipeThrough(
	new DelimiterTransformer({
		delimiter: Delimiter.Comma,
	})
)

for await (const columns of reader) {
	console.log(columns) // ["Full Name", "Occupation", "Age"]
}
```

## Extras

Ribbon also includes some quality-of-life features, such as normalizing CSV headers:

```ts
import { LineReader, DelimiterTransformer, Delimiter, normalizeColumnNames } from "@sister.software/ribbon"

const reader = new LineReader(fileHandle).pipeThrough(
	new DelimiterTransformer({
		delimiter: Delimiter.Comma,
	})
)

// Same as before, but we grab the iterator.
const iterator = reader[Symbol.asyncIterator]()

const headerResult = await iterator.next()

const headerColumns = normalizeColumnNames(headerResult.value)

console.log(headerColumns) // ["full_name", "occupation", "age"]
```

## Advanced usage

For more advanced use cases, check out our tests in the `test` directory, or our fully-annotated source code.

# License

Ribbon is licensed under the AGPL-3.0 license. Generally,
this means that you can use the software for free, but you must share
any modifications you make to the software.

For more information on commercial usage licensing, please contact us at
`hello@sister.software`
