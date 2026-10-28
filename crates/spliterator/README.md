# spliterator (Rust)

Streaming readers for delimited text, CSV, TSV, PSV and JSONL, with transparent zstd and gzip decompression.

This is the Rust counterpart of the [`spliterator`](https://www.npmjs.com/package/spliterator) npm package, and the
engine behind its Python package. All three read the same input into the same rows: the same defaults, the same
trimming, the same quote rules and the same errors. A shared conformance suite holds them to it.

```rust
use spliterator::{csv, jsonl, text};

for row in csv::Reader::open("people.csv", csv::Options::csv())? {
    let row = row?;
    println!("{:?}", row.get("Full Name"));
}

// Reads part-0000.jsonl.zst when it exists.
for value in jsonl::Reader::open("part-0000.jsonl", jsonl::Options::default())? {
    println!("{}", value?);
}

let lines: Vec<String> = text::Reader::from_bytes(b"  a \n\n b\n", text::Options::default())?.collect::<Result<_, _>>()?;
assert_eq!(lines, ["a", "b"]);

```

`text::count` and `csv::count` return the number of rows the matching reader would yield, without building them.

## Sources

`Reader::open` takes a path, bytes, or any `Read` (`Source`). A path `p` reads `p.zst`, or failing that `p.gz`, when one
exists; any source beginning with the zstd or gzip magic bytes is decompressed, frames and members concatenated. Both
are on by default (`OpenOptions`). `Reader::new` reads a stream as given.

## Features

| Feature | Default | Enables                                                |
| ------- | ------- | ------------------------------------------------------ |
| `zstd`  | yes     | zstd decompression (libzstd, through the `zstd` crate) |
| `gzip`  | yes     | gzip decompression (`flate2`, pure Rust)               |
| `json`  | yes     | the `jsonl` module (`serde_json`)                      |

The full semantics table is in the repository's `docs/v10.md`.
