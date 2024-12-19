# Ribbon 🎀

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
import { DelimitedJSONGenerator } from "@sister.software/ribbon"

interface Person {
	name: string
	age: number
}

const reader = DelimitedJSONGenerator.fromAsync("example.jsonl")

for await (const line of reader) {
	console.log(line) // {"name": "Alice", "age": 30}, etc.
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

While Ribbon supports any delimited byte stream, it's particularly useful for character-delimited content such as comma-separated values (CSV), tab-separated values (TSV) – or any other delimiter you can think of.

```csv
Full Name, Occupation, Age
Morgan, Developer, 30
Nataly, Designer, 40
Orlando, Manager, 50
```

```ts
import { CSVGenerator } from "@sister.software/ribbon"

const reader = CSVGenerator.fromAsync("people.csv")

for await (const columns of reader) {
	console.log(columns) // ["Full Name", "Occupation", "Age"], ["Morgan", "Developer", 30], etc.
}
```

CSV files can also be emitted as objects with headers as keys, with some quality-of-life features, such as normalizing property keys:

```ts
import { CSVGenerator } from "@sister.software/ribbon"

interface Person {
	full_name: string
	occupation: string
	age: number
}

const reader = CSVGenerator.fromAsync<Person>("people.csv", { mode: "object" })

for await (const columns of reader) {
	console.log(columns) // { full_name: "Morgan", occupation: "Developer", age: 30 }, etc.
}
```

## Advanced usage

Ribbon is designed to be simple to use, but also flexible and powerful.
For more advanced use cases, check out our tests in the `test` directory, or our fully-annotated source code.

### Reading from a stream

All Ribbon generators implement the `Generator` and `AsyncGenerator` interfaces, so you can use them in `for...of` and `for await...of` loops, as well the web-native [ReadableStreams](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream), so you can use them in `for await...of` loops, as well as piping them through transformations to avoid nested and partially materialized streams.

```ts
import { DelimitedJSONGenerator } from "@sister.software/ribbon"

const people = [
	{ name: "Alice", age: 30 },
	{ name: "Bob", age: 40 },
	{ name: "Charlie", age: 50 },
]

const generator = DelimitedJSONGenerator.from(people.map(JSON.stringify).join("\n"))
const stream = ReadableStream.from(generator)

for await (const line of stream) {
	console.log(line) // {"name": "Alice", "age": 30}, etc.
}
```

### Custom generators

While Ribbon includes premade exports for most use-cases, custom generators can be created via `DelimitedGenerator`. This class is a low-level interface that allows you to create your own generators for any kind of delimited content.

# License

Ribbon is licensed under the AGPL-3.0 license. Generally,
this means that you can use the software for free, but you must share
any modifications you make to the software.

For more information on commercial usage licensing, please contact us at
`hello@sister.software`
