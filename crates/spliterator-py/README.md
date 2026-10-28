# spliterator (Python)

```sh
pip install sister-software-spliterator
```

The distribution is `sister-software-spliterator`; the import name is `spliterator`.

Streaming readers for delimited text, CSV, TSV, PSV and JSONL, with transparent zstd and gzip decompression.

This is the Python counterpart of the [`spliterator`](https://www.npmjs.com/package/spliterator) npm package and the
[`spliterator`](https://crates.io/crates/spliterator) Rust crate. All three read the same input into the same rows:
the same defaults, the same trimming, the same quote rules and the same errors. A shared conformance suite holds them
to it.

```python
import spliterator

for row in spliterator.read_csv("people.csv"):          # {"Full Name": "Ada", "Age": "36"}
    ...

for value in spliterator.read_jsonl("part-0000.jsonl"):  # reads part-0000.jsonl.zst when it exists
    ...

for line in spliterator.read_text(b"  a \n\n b\n"):       # "a", "b"
    ...
```

## Async and counts

Each reader has an async twin that reads each batch on a worker thread, so the event loop never blocks on I/O:

```python
async for row in spliterator.aread_csv("people.csv"):
    ...
```

`count_text`, `count_csv`, `count_tsv` and `count_psv` return the number of rows the matching reader would yield,
without building them.

## Sources

A source is a path (`str` or `os.PathLike`), bytes-like data, or a binary file object.

- **Decompression.** A source that begins with the zstd or gzip magic bytes is decompressed before it is split, whatever
  its name. Concatenated frames and members are read through. Pass `decompress=False` to read the bytes as given.
- **Compressed siblings.** A path `p` reads `p.zst`, or failing that `p.gz`, when one exists. Pass
  `prefer_compressed=False` to read `p` itself.
- **Laziness.** Nothing is opened until the first row is pulled.

## Defaults worth knowing

| Option                  | Default                       | Notes                                                                                                                               |
| ----------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `trim`                  | `True`                        | Strips the ECMAScript whitespace set (U+FEFF included, U+0085 not), not `str.strip`'s. CSV trims cells and headers after unquoting. |
| `skip_empty`            | `True`                        | Drops empty records; for text, rows that trim to nothing; for JSONL, whitespace-only rows.                                          |
| `normalize_keys`        | `False`                       | CSV keys are the header as written. In object mode a repeated header raises `DuplicateHeaderError`.                                 |
| `enable_quote_handling` | CSV/PSV `True`, TSV `False`   | Input that ends inside quotes raises `UnterminatedQuoteError` after the rows before it.                                             |
| `crlf`                  | CSV `True`, otherwise `False` |                                                                                                                                     |

`drop` and `take` count the rows you receive. JSONL rejects `NaN` and `Infinity`, keeps large integers exact, and
raises `JSONRowError` with the failing row's index.

The full semantics table is in the repository's `docs/v10.md`.

## Errors

`SpliteratorError` is the base of `UnterminatedQuoteError` (`.byte_offset`), `DuplicateHeaderError` (`.column`) and
`JSONRowError` (`.row`), each also a `ValueError`. I/O failures raise the usual `OSError` subclasses.
