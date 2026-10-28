//! Text rows: records decoded as lossy UTF-8, one BOM removed per record, trimmed by default.

use std::io::Read;

use crate::error::Result;
use crate::records::{RecordOptions, RecordReader};
use crate::source::{open, OpenOptions, Source};
use crate::whitespace::trim;

const BOM: char = '\u{FEFF}';

/// Options for [`Reader`]. The defaults match `TextSpliterator`'s.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    /// The record delimiter. Default `\n`.
    pub delimiter: Vec<u8>,
    /// Remove leading and trailing whitespace (the ECMAScript set) from each row. Default `true`.
    pub trim: bool,
    /// Drop empty records, and with `trim` rows that trim to nothing. Default `true`.
    pub skip_empty: bool,
    /// Treat one `\r` before a delimiter as part of it. Default `false`; `trim` removes it anyway.
    pub crlf: bool,
    /// Rows to skip, counted after skipping. Default `0`.
    pub drop: usize,
    /// Rows to yield at most, counted after skipping. Default unlimited.
    pub take: Option<usize>,
    /// Keep a delimiter inside `"…"` from splitting. Default `false`.
    pub enable_quote_handling: bool,
    /// Read input ending inside quotes instead of failing. Default `false`.
    pub allow_unterminated_quote: bool,
    /// How the source is opened.
    pub open: OpenOptions,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            delimiter: b"\n".to_vec(),
            trim: true,
            skip_empty: true,
            crlf: false,
            drop: 0,
            take: None,
            enable_quote_handling: false,
            allow_unterminated_quote: false,
            open: OpenOptions::default(),
        }
    }
}

impl Options {
    pub(crate) fn record_options(&self) -> RecordOptions {
        RecordOptions {
            delimiter: self.delimiter.clone(),
            enable_quote_handling: self.enable_quote_handling,
            allow_unterminated_quote: self.allow_unterminated_quote,
            crlf: self.crlf,
            skip_empty: self.skip_empty,
        }
    }
}

/// Decode a record: lossy UTF-8 (one U+FFFD per maximal invalid subsequence), then one leading BOM removed.
pub(crate) fn decode_record(bytes: &[u8]) -> String {
    let mut text = String::from_utf8_lossy(bytes).into_owned();

    if text.starts_with(BOM) {
        text.drain(..BOM.len_utf8());
    }

    text
}

/// Counts `drop` and `take` against the rows a reader yields.
#[derive(Debug, Clone)]
pub(crate) struct Window {
    to_drop: usize,
    remaining: Option<usize>,
}

impl Window {
    pub(crate) fn new(drop: usize, take: Option<usize>) -> Self {
        Window {
            to_drop: drop,
            remaining: take,
        }
    }

    /// Whether every row the window allows has been yielded.
    pub(crate) fn exhausted(&self) -> bool {
        self.remaining == Some(0)
    }

    /// Whether to yield the next row that survived skipping.
    pub(crate) fn admit(&mut self) -> bool {
        if self.to_drop > 0 {
            self.to_drop -= 1;

            return false;
        }

        if let Some(remaining) = self.remaining.as_mut() {
            *remaining -= 1;
        }

        true
    }
}

/// An iterator of text rows.
pub struct Reader<R: Read> {
    records: RecordReader<R>,
    trim: bool,
    drop_blank: bool,
    window: Window,
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
            records: RecordReader::new(reader, options.record_options())?,
            trim: options.trim,
            drop_blank: options.trim && options.skip_empty,
            window: Window::new(options.drop, options.take),
        })
    }
}

impl<R: Read> Iterator for Reader<R> {
    type Item = Result<String>;

    fn next(&mut self) -> Option<Self::Item> {
        while !self.window.exhausted() {
            let record = match self.records.next()? {
                Ok(record) => record,
                Err(error) => return Some(Err(error)),
            };

            let mut row = decode_record(&record.bytes);

            if self.trim {
                let trimmed = trim(&row);

                if self.drop_blank && trimmed.is_empty() {
                    continue;
                }

                if trimmed.len() != row.len() {
                    row = trimmed.to_owned();
                }
            }

            if self.window.admit() {
                return Some(Ok(row));
            }
        }

        None
    }
}

/// Whether a raw record would be dropped as blank: decoded, its BOM removed and trimmed to nothing. An ASCII record is
/// judged on its bytes, so only a record holding non-ASCII bytes is decoded.
pub(crate) fn is_blank_record(bytes: &[u8]) -> bool {
    for &byte in bytes {
        if byte >= 0x80 {
            return crate::whitespace::is_blank(&decode_record(bytes));
        }

        if !matches!(byte, b' ' | b'\t' | b'\n' | 0x0B | 0x0C | b'\r') {
            return false;
        }
    }

    true
}

/// The number of rows [`Reader`] would yield for `source`, without building them.
pub fn count(source: impl Into<Source>, options: Options) -> Result<usize> {
    count_reader(open(source.into(), options.open)?, options)
}

/// The number of rows [`Reader::new`] would yield for an already open, already decompressed stream.
pub fn count_reader<R: Read>(reader: R, options: Options) -> Result<usize> {
    let drop_blank = options.trim && options.skip_empty;
    let mut window = Window::new(options.drop, options.take);
    let mut count = 0;

    for record in RecordReader::new(reader, options.record_options())? {
        if window.exhausted() {
            break;
        }

        let record = record?;

        if drop_blank && is_blank_record(&record.bytes) {
            continue;
        }

        if window.admit() {
            count += 1;
        }
    }

    Ok(count)
}
