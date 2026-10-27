//! JSONL rows, parsed with `serde_json`. Blank rows are skipped, comment prefixes are honoured, and `drop`/`take` count
//! the rows that reach the parser, as in `JSONSpliterator`.

use std::io::Read;

use serde_json::Value;

use crate::error::{Error, Result};
use crate::records::{RecordOptions, RecordReader};
use crate::source::{open, OpenOptions, Source};
use crate::text::{decode_record, Window};
use crate::whitespace::is_blank;

/// Options for [`Reader`]. The defaults match `JSONSpliterator`'s.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    /// The record delimiter. Default `\n`.
    pub delimiter: Vec<u8>,
    /// Skip empty and whitespace-only rows. Default `true`.
    pub skip_empty: bool,
    /// Treat one `\r` before a delimiter as part of it. Default `false`; JSON ignores it anyway.
    pub crlf: bool,
    /// Skip rows whose first non-whitespace text starts with one of these prefixes, and whitespace-only rows. Empty
    /// prefixes are ignored. Default: no comments.
    pub comment: Option<Vec<String>>,
    /// Rows to skip, counted after skipping. Default `0`.
    pub drop: usize,
    /// Rows to parse at most, counted after skipping. Default unlimited.
    pub take: Option<usize>,
    /// How the source is opened.
    pub open: OpenOptions,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            delimiter: b"\n".to_vec(),
            skip_empty: true,
            crlf: false,
            comment: None,
            drop: 0,
            take: None,
            open: OpenOptions::default(),
        }
    }
}

/// Whether a row is a comment (or, once comments are configured, whitespace-only). Leading spaces, tabs, CRs and LFs
/// are passed over before the prefixes are tested.
pub fn is_comment(row: &str, prefixes: &[String]) -> bool {
    let rest = row.trim_start_matches([' ', '\t', '\r', '\n']);

    rest.is_empty()
        || prefixes
            .iter()
            .any(|prefix| !prefix.is_empty() && rest.starts_with(prefix.as_str()))
}

/// The decoded rows that reach the parser: comments, blank rows and `drop` already applied, `take` honoured.
pub struct Rows<R: Read> {
    records: RecordReader<R>,
    skip_blank: bool,
    comment: Option<Vec<String>>,
    window: Window,
}

impl<R: Read> Rows<R> {
    pub fn new(reader: R, options: &Options) -> Result<Self> {
        Ok(Rows {
            records: RecordReader::new(
                reader,
                RecordOptions {
                    delimiter: options.delimiter.clone(),
                    enable_quote_handling: false,
                    allow_unterminated_quote: false,
                    crlf: options.crlf,
                    skip_empty: options.skip_empty,
                },
            )?,
            skip_blank: options.skip_empty,
            comment: options.comment.clone(),
            window: Window::new(options.drop, options.take),
        })
    }
}

impl<R: Read> Iterator for Rows<R> {
    type Item = Result<String>;

    fn next(&mut self) -> Option<Self::Item> {
        while !self.window.exhausted() {
            let record = match self.records.next()? {
                Ok(record) => record,
                Err(error) => return Some(Err(error)),
            };

            let row = decode_record(&record.bytes);

            if let Some(prefixes) = &self.comment {
                if is_comment(&row, prefixes) {
                    continue;
                }
            }

            if self.skip_blank && is_blank(&row) {
                continue;
            }

            if self.window.admit() {
                return Some(Ok(row));
            }
        }

        None
    }
}

/// An iterator of parsed JSONL values.
pub struct Reader<R: Read> {
    rows: Rows<R>,
    row: usize,
}

impl Reader<Box<dyn Read + Send>> {
    /// Open a path, bytes or reader.
    pub fn open(source: impl Into<Source>, options: Options) -> Result<Self> {
        let reader = open(source.into(), options.open)?;

        Reader::new(reader, options)
    }
}

impl<'a> Reader<&'a [u8]> {
    /// Read bytes in memory, without decompression.
    pub fn from_bytes(bytes: &'a [u8], options: Options) -> Result<Self> {
        Reader::new(bytes, options)
    }
}

impl<R: Read> Reader<R> {
    /// Read an already open, already decompressed stream.
    pub fn new(reader: R, options: Options) -> Result<Self> {
        Ok(Reader {
            rows: Rows::new(reader, &options)?,
            row: 0,
        })
    }
}

impl<R: Read> Iterator for Reader<R> {
    type Item = Result<Value>;

    fn next(&mut self) -> Option<Self::Item> {
        let text = match self.rows.next()? {
            Ok(text) => text,
            Err(error) => return Some(Err(error)),
        };

        let row = self.row;
        self.row += 1;

        Some(serde_json::from_str(&text).map_err(|source| Error::JsonRow { row, source }))
    }
}
