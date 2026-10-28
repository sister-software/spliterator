//! The record engine: splits a byte stream on a delimiter, optionally treating double-quoted regions as opaque.
//!
//! The rules are the TypeScript engines' (`Spliterator`, `AsyncSpliterator`): one `\r` directly before a delimiter
//! belongs to the delimiter when `crlf` is on; the bytes after the last delimiter are a record even when empty, as
//! `String.prototype.split` cuts them; `skip_empty` drops records whose bytes are empty after CRLF removal. Memory holds
//! the record in flight plus at most one read chunk ahead of it; a record is never split to bound memory.

use std::io::Read;

use memchr::memmem::Finder;

use crate::error::{Error, Result};
use crate::source::READ_CHUNK;

const QUOTE: u8 = b'"';
const CARRIAGE_RETURN: u8 = b'\r';

/// How the engine cuts records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordOptions {
    /// The record delimiter. Must not be empty, and must not contain `"` when quote handling is on.
    pub delimiter: Vec<u8>,
    /// Treat each `"` as toggling a quoted region in which a delimiter does not split.
    pub enable_quote_handling: bool,
    /// Read input that ends inside quotes as one final record instead of returning
    /// [`Error::UnterminatedQuote`].
    pub allow_unterminated_quote: bool,
    /// Treat one `\r` directly before a delimiter as part of the delimiter.
    pub crlf: bool,
    /// Drop records whose bytes are empty after CRLF removal.
    pub skip_empty: bool,
}

impl Default for RecordOptions {
    fn default() -> Self {
        RecordOptions {
            delimiter: b"\n".to_vec(),
            enable_quote_handling: false,
            allow_unterminated_quote: false,
            crlf: false,
            skip_empty: true,
        }
    }
}

impl RecordOptions {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.delimiter.is_empty() {
            return Err(Error::InvalidOptions(
                "the delimiter must not be empty".into(),
            ));
        }

        if self.enable_quote_handling && self.delimiter.contains(&QUOTE) {
            return Err(Error::InvalidOptions(
                "a delimiter containing `\"` cannot be used with quote handling".into(),
            ));
        }

        Ok(())
    }
}

/// A record and where it began in the (decompressed) input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub bytes: Vec<u8>,
    pub byte_offset: u64,
}

/// Splits a reader into records. An iterator of `Result<Record>`; after an error it yields nothing more.
pub struct RecordReader<R: Read> {
    reader: R,
    options: RecordOptions,
    finder: Finder<'static>,
    buffer: Vec<u8>,
    /// Bytes discarded from the front of `buffer`, so `discarded + start` is a stream offset.
    discarded: u64,
    /// Where the record in flight begins.
    start: usize,
    /// How far scanning has got. Everything in `start..cursor` belongs to the record in flight.
    cursor: usize,
    inside_quotes: bool,
    eof: bool,
    done: bool,
}

impl<R: Read> RecordReader<R> {
    pub fn new(reader: R, options: RecordOptions) -> Result<Self> {
        options.validate()?;

        let finder = Finder::new(&options.delimiter).into_owned();

        Ok(RecordReader {
            reader,
            options,
            finder,
            buffer: Vec::with_capacity(READ_CHUNK),
            discarded: 0,
            start: 0,
            cursor: 0,
            inside_quotes: false,
            eof: false,
            done: false,
        })
    }

    /// Read another chunk, first sliding the consumed prefix out of the buffer. Returns `false` at end of input.
    fn fill(&mut self) -> Result<bool> {
        if self.start > 0 {
            self.buffer.drain(..self.start);
            self.discarded += self.start as u64;
            self.cursor -= self.start;
            self.start = 0;
        }

        let length = self.buffer.len();
        self.buffer.resize(length + READ_CHUNK, 0);

        loop {
            match self.reader.read(&mut self.buffer[length..]) {
                Ok(read) => {
                    self.buffer.truncate(length + read);

                    if read == 0 {
                        self.eof = true;
                    }

                    return Ok(read > 0);
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    self.buffer.truncate(length);

                    return Err(error.into());
                }
            }
        }
    }

    /// The position of the next delimiter at or after `cursor` that is outside quotes, advancing `cursor` and the quote
    /// state past everything scanned. `None` means more input is needed (or the input has ended).
    fn find_delimiter(&mut self) -> Option<usize> {
        let delimiter_length = self.options.delimiter.len();

        if !self.options.enable_quote_handling {
            let found = self
                .finder
                .find(&self.buffer[self.cursor..])
                .map(|position| self.cursor + position);

            if found.is_none() {
                // A delimiter may begin in the last `length - 1` bytes and finish in the next chunk.
                self.cursor = self
                    .start
                    .max(self.buffer.len().saturating_sub(delimiter_length - 1));
            }

            return found;
        }

        let first = self.options.delimiter[0];

        while self.cursor < self.buffer.len() {
            let Some(offset) = memchr::memchr2(first, QUOTE, &self.buffer[self.cursor..]) else {
                self.cursor = self.buffer.len();

                return None;
            };

            let position = self.cursor + offset;

            if self.buffer[position] == QUOTE {
                self.inside_quotes = !self.inside_quotes;
                self.cursor = position + 1;

                continue;
            }

            if self.inside_quotes {
                self.cursor = position + 1;

                continue;
            }

            if position + delimiter_length > self.buffer.len() {
                // Too few bytes to tell whether the delimiter is here; wait for more without consuming its first byte.
                self.cursor = position;

                return None;
            }

            if self.buffer[position..position + delimiter_length] == self.options.delimiter[..] {
                return Some(position);
            }

            self.cursor = position + 1;
        }

        None
    }

    fn next_record(&mut self) -> Result<Option<Record>> {
        loop {
            if self.done {
                return Ok(None);
            }

            if let Some(position) = self.find_delimiter() {
                let start = self.start;
                let mut end = position;

                if self.options.crlf && end > start && self.buffer[end - 1] == CARRIAGE_RETURN {
                    end -= 1;
                }

                let record = Record {
                    bytes: self.buffer[start..end].to_vec(),
                    byte_offset: self.discarded + start as u64,
                };

                self.start = position + self.options.delimiter.len();
                self.cursor = self.start;

                if record.bytes.is_empty() && self.options.skip_empty {
                    continue;
                }

                return Ok(Some(record));
            }

            if !self.eof {
                self.fill()?;

                continue;
            }

            // End of input: whatever follows the last delimiter is the final record, even when empty.
            self.done = true;

            if self.options.enable_quote_handling
                && self.inside_quotes
                && !self.options.allow_unterminated_quote
            {
                return Err(Error::UnterminatedQuote {
                    byte_offset: self.discarded + self.start as u64,
                });
            }

            let record = Record {
                bytes: self.buffer[self.start..].to_vec(),
                byte_offset: self.discarded + self.start as u64,
            };

            if record.bytes.is_empty() && self.options.skip_empty {
                return Ok(None);
            }

            return Ok(Some(record));
        }
    }
}

impl<R: Read> Iterator for RecordReader<R> {
    type Item = Result<Record>;

    fn next(&mut self) -> Option<Self::Item> {
        match self.next_record() {
            Ok(record) => record.map(Ok),
            Err(error) => {
                self.done = true;

                Some(Err(error))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(input: &[u8], options: RecordOptions) -> Vec<String> {
        RecordReader::new(input, options)
            .unwrap()
            .map(|record| String::from_utf8(record.unwrap().bytes).unwrap())
            .collect()
    }

    #[test]
    fn splits_like_string_split() {
        let keep = RecordOptions {
            skip_empty: false,
            ..Default::default()
        };

        assert_eq!(split(b"a\nb\n", keep.clone()), ["a", "b", ""]);
        assert_eq!(split(b"", keep), [""]);
        assert_eq!(split(b"a\n\nb\n", RecordOptions::default()), ["a", "b"]);
    }

    #[test]
    fn multi_byte_delimiters_across_chunks() {
        let options = RecordOptions {
            delimiter: b"||".to_vec(),
            ..Default::default()
        };
        let input = format!("{}||b||||c", "a".repeat(READ_CHUNK - 1));
        let records = split(input.as_bytes(), options);

        assert_eq!(records.len(), 3);
        assert_eq!(records[1], "b");
        assert_eq!(records[2], "c");
    }

    #[test]
    fn quotes_protect_delimiters_and_report_open_records() {
        let options = RecordOptions {
            enable_quote_handling: true,
            ..Default::default()
        };

        assert_eq!(
            split(b"a\n\"b\nc\"\nd", options.clone()),
            ["a", "\"b\nc\"", "d"]
        );

        let error = RecordReader::new(&b"a\n\"b\nc"[..], options)
            .unwrap()
            .nth(1)
            .unwrap()
            .unwrap_err();

        assert!(matches!(error, Error::UnterminatedQuote { byte_offset: 2 }));
    }

    #[test]
    fn crlf_only_before_a_delimiter() {
        let options = RecordOptions {
            crlf: true,
            ..Default::default()
        };

        assert_eq!(split(b"a\r\nb\r", options), ["a", "b\r"]);
    }
}
