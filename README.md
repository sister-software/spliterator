# What is Ribbon?

Ribbon makes newline-delimited files easy to work with.

Let's say you have a newline-delimited JSON file called `example.csv`:

```json
{"name": "Alice", "age": 30}
{"name": "Bob", "age": 40}
{"name": "Charlie", "age": 50}
```

LineReaders extend native [ReadableStreams](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream), so you can use them in `for await...of` loops:

```ts
import { LineReader } from "@sister.software/ribbon"

const reader = new LineReader("example.csv")

for await (const line of reader) {
	console.log(line.toString())
}
```

[![npm version](https://img.shields.io/npm/v/ribbon.svg)](https://www.npmjs.com/package/ribbon)

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
Jessie, Developer, 30
Kelly, Designer, 40
Loren, Manager, 50
```

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
