//! Streaming readers for delimited text, CSV, TSV, PSV and JSONL.
//!
//! The Rust counterpart of the [`spliterator`](https://www.npmjs.com/package/spliterator) npm package. Both read the
//! same input into the same rows: the same defaults, the same trimming, the same quote rules and the same errors. The
//! contract is the conformance suite in the repository's `conformance/` directory, which this crate's tests run.
//!
//! ```
//! use spliterator::csv;
//!
//! let input = b"name,age\nAda,36\n";
//! let rows: Vec<csv::Row> = csv::Reader::from_bytes(input, csv::Options::csv())?.collect::<Result<_, _>>()?;
//!
//! assert_eq!(rows[0].get("age"), Some("36"));
//! # Ok::<(), spliterator::Error>(())
//! ```
//!
//! A path source reads `path.zst` or `path.gz` in its place when one exists, and any source that begins with the zstd
//! or gzip magic bytes is decompressed before it is split. Both are on by default ([`OpenOptions`]).

pub mod csv;
mod error;
#[cfg(feature = "json")]
pub mod jsonl;
pub mod keys;
pub mod records;
pub mod source;
pub mod text;
pub mod whitespace;

pub use error::{Error, Result};
pub use source::{
    open, resolve_compressed_sibling, sniff_compression, Compression, OpenOptions, Source,
};
