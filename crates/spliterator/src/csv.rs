//! CSV, TSV and PSV rows, with `CSVSpliterator`'s rules: records cut with quote state in hand, each decoded and split
//! into cells, cells unquoted and trimmed, the first record taken as the header.

use std::collections::HashSet;
use std::io::Read;
use std::sync::Arc;

use crate::error::{Error, Result};
use crate::keys::normalize_column_names;
use crate::records::{RecordOptions, RecordReader};
use crate::source::{open, OpenOptions, Source};
use crate::text::{decode_record, Window};
use crate::whitespace::trim;

const QUOTE: u8 = b'"';

/// The shape of each data row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Cells keyed by header name.
    Object,
    /// Cells by position.
    Array,
    /// `(key, value, index)` triples.
    Entries,
}

/// Options for [`Reader`]. [`Options::csv`] (the default), [`Options::tsv`] and [`Options::psv`] match
/// `CSVSpliterator`, `TSVSpliterator` and `PSVSpliterator`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    /// The row delimiter. Default `\n`.
    pub row_delimiter: Vec<u8>,
    /// The column delimiter. `,` for CSV, `\t` for TSV, `|` for PSV.
    pub column_delimiter: Vec<u8>,
    /// Keep delimiters inside `"…"` from splitting, and unquote cells. On for CSV and PSV, off for TSV.
    pub enable_quote_handling: bool,
    /// Read input ending inside quotes instead of failing. Default `false`.
    pub allow_unterminated_quote: bool,
    /// Treat one `\r` before a row delimiter as part of it. Default `true`.
    pub crlf: bool,
    /// Trim each cell, header included, after unquoting. Default `true`.
    pub trim: bool,
    /// Drop records whose bytes are empty after CRLF removal. Default `true`.
    pub skip_empty: bool,
    /// Take the first record as the header. Default `true`.
    pub header: bool,
    /// The row shape. Default: [`Mode::Object`] with a header, [`Mode::Array`] without.
    pub mode: Option<Mode>,
    /// Snake-case header names and suffix repeats. Default `false`.
    pub normalize_keys: bool,
    /// Data rows to skip. Default `0`.
    pub drop: usize,
    /// Data rows to yield at most. Default unlimited.
    pub take: Option<usize>,
    /// How the source is opened.
    pub open: OpenOptions,
}

impl Default for Options {
    fn default() -> Self {
        Options::csv()
    }
}

impl Options {
    /// Comma-separated values.
    pub fn csv() -> Self {
        Options {
            row_delimiter: b"\n".to_vec(),
            column_delimiter: b",".to_vec(),
            enable_quote_handling: true,
            allow_unterminated_quote: false,
            crlf: true,
            trim: true,
            skip_empty: true,
            header: true,
            mode: None,
            normalize_keys: false,
            drop: 0,
            take: None,
            open: OpenOptions::default(),
        }
    }

    /// Tab-separated values. The TSV format has no quoting, so a `"` is data.
    pub fn tsv() -> Self {
        Options {
            column_delimiter: b"\t".to_vec(),
            enable_quote_handling: false,
            ..Options::csv()
        }
    }

    /// Pipe-separated values.
    pub fn psv() -> Self {
        Options {
            column_delimiter: b"|".to_vec(),
            ..Options::csv()
        }
    }

    /// The mode rows take: the explicit one, or the default for `header`.
    pub fn resolved_mode(&self) -> Mode {
        self.mode.unwrap_or(if self.header {
            Mode::Object
        } else {
            Mode::Array
        })
    }
}

/// A data row: its cells, and the header they line up with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub cells: Vec<String>,
    pub headers: Option<Arc<[String]>>,
}

impl Row {
    /// `(key, value)` pairs in header order. A column the row lacks is `""`, and cells past the header are keyed
    /// `column_<index>`. Without a header every cell is keyed by index.
    pub fn to_pairs(&self) -> Vec<(String, String)> {
        self.to_entries()
            .into_iter()
            .map(|(key, value, _)| (key, value))
            .collect()
    }

    /// `(key, value, index)` triples, with the same fill rules as [`Row::to_pairs`].
    pub fn to_entries(&self) -> Vec<(String, String, usize)> {
        let headers: &[String] = self.headers.as_deref().unwrap_or(&[]);
        let width = headers.len().max(self.cells.len());

        (0..width)
            .map(|index| {
                let key = headers
                    .get(index)
                    .cloned()
                    .unwrap_or_else(|| format!("column_{index}"));
                let value = self.cells.get(index).cloned().unwrap_or_default();

                (key, value, index)
            })
            .collect()
    }

    /// The cell under `column`, or `""` when the header has the column and the row does not reach it.
    pub fn get(&self, column: &str) -> Option<&str> {
        let index = self
            .headers
            .as_deref()?
            .iter()
            .position(|header| header == column)?;

        Some(self.cells.get(index).map_or("", String::as_str))
    }
}

/// An iterator of CSV data rows.
pub struct Reader<R: Read> {
    records: RecordReader<R>,
    splitter: ColumnSplitter,
    header_pending: bool,
    normalize_keys: bool,
    mode: Mode,
    headers: Option<Arc<[String]>>,
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
        if options.column_delimiter.is_empty() {
            return Err(Error::InvalidOptions(
                "the column delimiter must not be empty".into(),
            ));
        }

        let records = RecordReader::new(
            reader,
            RecordOptions {
                delimiter: options.row_delimiter.clone(),
                enable_quote_handling: options.enable_quote_handling,
                allow_unterminated_quote: options.allow_unterminated_quote,
                crlf: options.crlf,
                skip_empty: options.skip_empty,
            },
        )?;

        Ok(Reader {
            records,
            splitter: ColumnSplitter::new(
                &options.column_delimiter,
                options.enable_quote_handling,
                options.trim,
            ),
            header_pending: options.header,
            normalize_keys: options.normalize_keys,
            mode: options.resolved_mode(),
            headers: None,
            window: Window::new(options.drop, options.take),
        })
    }

    /// The header, once the first row has been read (or the input turned out to hold only a header).
    pub fn headers(&self) -> Option<&[String]> {
        self.headers.as_deref()
    }

    /// The mode rows are shaped for.
    pub fn mode(&self) -> Mode {
        self.mode
    }

    fn read_header(&mut self, cells: Vec<String>) -> Result<()> {
        let names = if self.normalize_keys {
            normalize_column_names(&cells)
        } else {
            if self.mode == Mode::Object {
                let mut seen = HashSet::new();

                for name in &cells {
                    if !seen.insert(name.as_str()) {
                        return Err(Error::DuplicateHeader {
                            column: name.clone(),
                        });
                    }
                }
            }

            cells
        };

        self.headers = Some(names.into());

        Ok(())
    }
}

impl<R: Read> Iterator for Reader<R> {
    type Item = Result<Row>;

    fn next(&mut self) -> Option<Self::Item> {
        while !self.window.exhausted() {
            let record = match self.records.next()? {
                Ok(record) => record,
                Err(error) => return Some(Err(error)),
            };

            let cells = self.splitter.split(&record.bytes);

            if self.header_pending {
                self.header_pending = false;

                if let Err(error) = self.read_header(cells) {
                    // The rows are keyed by a header that cannot key them; nothing after it is readable.
                    self.window = Window::new(0, Some(0));

                    return Some(Err(error));
                }

                continue;
            }

            if self.window.admit() {
                return Some(Ok(Row {
                    cells,
                    headers: self.headers.clone(),
                }));
            }
        }

        None
    }
}

/// The number of data rows [`Reader`] would yield for `source`, without splitting cells. The header is skipped but not
/// read, so a repeated header is not an error here.
pub fn count(source: impl Into<Source>, options: Options) -> Result<usize> {
    count_reader(open(source.into(), options.open)?, options)
}

/// The number of data rows [`Reader::new`] would yield for an already open, already decompressed stream.
pub fn count_reader<R: Read>(reader: R, options: Options) -> Result<usize> {
    let records = RecordReader::new(
        reader,
        RecordOptions {
            delimiter: options.row_delimiter.clone(),
            enable_quote_handling: options.enable_quote_handling,
            allow_unterminated_quote: options.allow_unterminated_quote,
            crlf: options.crlf,
            skip_empty: options.skip_empty,
        },
    )?;

    let mut header_pending = options.header;
    let mut window = Window::new(options.drop, options.take);
    let mut count = 0;

    for record in records {
        if window.exhausted() {
            break;
        }

        record?;

        if header_pending {
            header_pending = false;

            continue;
        }

        if window.admit() {
            count += 1;
        }
    }

    Ok(count)
}

/// Splits one record into cells.
struct ColumnSplitter {
    /// The delimiter as text, when it is valid UTF-8; otherwise cells are split on the raw bytes.
    text_delimiter: Option<String>,
    byte_delimiter: Vec<u8>,
    enable_quote_handling: bool,
    trim: bool,
}

impl ColumnSplitter {
    fn new(delimiter: &[u8], enable_quote_handling: bool, trim: bool) -> Self {
        ColumnSplitter {
            text_delimiter: std::str::from_utf8(delimiter).ok().map(str::to_owned),
            byte_delimiter: delimiter.to_vec(),
            enable_quote_handling,
            trim,
        }
    }

    fn split(&self, record: &[u8]) -> Vec<String> {
        let mut cells = match &self.text_delimiter {
            Some(delimiter) => {
                let line = decode_record(record);

                // A row without a quote cannot hold a quoted field, so a plain split gives the same cells.
                if !self.enable_quote_handling || !line.contains('"') {
                    line.split(delimiter.as_str()).map(str::to_owned).collect()
                } else {
                    split_quoted(&line, delimiter)
                }
            }
            None => self.split_bytes(record),
        };

        if self.trim {
            for cell in &mut cells {
                if let Some(normalized) = normalize_cell(cell, self.enable_quote_handling) {
                    *cell = normalized;
                }
            }
        }

        cells
    }

    /// The byte path, for a delimiter that is not valid UTF-8 and so cannot be searched for in decoded text.
    fn split_bytes(&self, record: &[u8]) -> Vec<String> {
        let delimiter = &self.byte_delimiter[..];
        let mut cells = Vec::new();
        let mut inside_quotes = false;
        let mut start = 0;
        let mut index = 0;

        while index < record.len() {
            if self.enable_quote_handling && record[index] == QUOTE {
                inside_quotes = !inside_quotes;
                index += 1;
            } else if !inside_quotes && record[index..].starts_with(delimiter) {
                cells.push(self.decode_cell(&record[start..index], cells.is_empty()));
                index += delimiter.len();
                start = index;
            } else {
                index += 1;
            }
        }

        cells.push(self.decode_cell(&record[start..], cells.is_empty()));

        cells
    }

    fn decode_cell(&self, bytes: &[u8], first: bool) -> String {
        let value = if first {
            decode_record(bytes)
        } else {
            String::from_utf8_lossy(bytes).into_owned()
        };

        if self.enable_quote_handling {
            unquote_column(&value).unwrap_or(value)
        } else {
            value
        }
    }
}

/// Split one decoded row on `delimiter`, honouring double quotes, and unquote each field in the same pass. A doubled
/// quote is a quote seen inside quotes with another directly after it, and only then is `""` unescaped.
fn split_quoted(line: &str, delimiter: &str) -> Vec<String> {
    let bytes = line.as_bytes();
    let delimiter = delimiter.as_bytes();
    let mut cells = Vec::new();
    let mut start = 0;
    let mut index = 0;
    let mut inside_quotes = false;
    let mut saw_doubled_quote = false;

    while index < bytes.len() {
        if bytes[index] == QUOTE {
            if inside_quotes && bytes.get(index + 1) == Some(&QUOTE) {
                saw_doubled_quote = true;
                index += 2;

                continue;
            }

            inside_quotes = !inside_quotes;
            index += 1;
        } else if !inside_quotes && bytes[index..].starts_with(delimiter) {
            cells.push(unquote_slice(line, start, index, saw_doubled_quote));
            saw_doubled_quote = false;
            index += delimiter.len();
            start = index;
        } else {
            index += 1;
        }
    }

    cells.push(unquote_slice(line, start, bytes.len(), saw_doubled_quote));

    cells
}

/// The cell `line[start..end]`, without its wrapping quotes when it has them.
fn unquote_slice(line: &str, start: usize, end: usize, saw_doubled_quote: bool) -> String {
    let bytes = line.as_bytes();

    if end - start >= 2 && bytes[start] == QUOTE && bytes[end - 1] == QUOTE {
        let inner = &line[start + 1..end - 1];

        return if saw_doubled_quote {
            inner.replace("\"\"", "\"")
        } else {
            inner.to_owned()
        };
    }

    line[start..end].to_owned()
}

/// `value` without wrapping quotes, `""` unescaped, or `None` when it is not wrapped in quotes.
fn unquote_column(value: &str) -> Option<String> {
    let bytes = value.as_bytes();

    if bytes.len() >= 2 && bytes[0] == QUOTE && bytes[bytes.len() - 1] == QUOTE {
        let inner = &value[1..value.len() - 1];

        return Some(if inner.contains("\"\"") {
            inner.replace("\"\"", "\"")
        } else {
            inner.to_owned()
        });
    }

    None
}

/// Whether a cell's edge character could be something `trim` removes: ASCII whitespace, or anything non-ASCII.
fn may_need_trim(c: char) -> bool {
    (c as u32) <= 0x20 || (c as u32) >= 0x80
}

/// The trimmed cell, or `None` when it is already as trimmed as it gets. Padding outside the quotes (` " Ada " `) is
/// unquoted after trimming exposes the quotes, then trimmed again. A cell whose first and last characters are both
/// printable ASCII is left exactly as it is, which is not the same as trimming it: `"a"` left over from unquoting
/// `"""a"""` keeps its quotes.
fn normalize_cell(value: &str, enable_quote_handling: bool) -> Option<String> {
    let (first, last) = (value.chars().next()?, value.chars().next_back()?);

    if !may_need_trim(first) && !may_need_trim(last) {
        return None;
    }

    let trimmed = trim(value);

    if enable_quote_handling && trimmed.as_bytes().first() == Some(&QUOTE) {
        let unquoted = unquote_column(trimmed).unwrap_or_else(|| trimmed.to_owned());

        return Some(trim(&unquoted).to_owned());
    }

    (trimmed.len() != value.len()).then(|| trimmed.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(input: &str, options: Options) -> Vec<Vec<String>> {
        Reader::from_bytes(input.as_bytes(), options)
            .unwrap()
            .map(|row| row.unwrap().cells)
            .collect()
    }

    #[test]
    fn quoted_cells() {
        let options = Options {
            header: false,
            ..Options::csv()
        };

        assert_eq!(
            rows("\"a,x\",b\n\"c\nd\",e\n", options.clone()),
            [vec!["a,x", "b"], vec!["c\nd", "e"]]
        );
        assert_eq!(rows("\"\",\"\"\"\"\n", options.clone()), [vec!["", "\""]]);
        assert_eq!(rows("\"\"\"a\"\"\"\n", options.clone()), [vec!["\"a\""]]);
        assert_eq!(rows("  \"x\"  \n", options), [vec!["x"]]);
    }

    #[test]
    fn non_utf8_delimiter_uses_the_byte_path() {
        let options = Options {
            header: false,
            column_delimiter: vec![0xFF],
            ..Options::csv()
        };
        let input = [b'a', 0xFF, b'"', b'b', 0xFF, b'c', b'"', b'\n'];
        let cells: Vec<Vec<String>> = Reader::from_bytes(&input, options)
            .unwrap()
            .map(|row| row.unwrap().cells)
            .collect();

        assert_eq!(cells, [vec!["a", "b\u{FFFD}c"]]);
    }

    #[test]
    fn duplicate_headers() {
        let error = Reader::from_bytes(b"k,k\n1,2\n", Options::csv())
            .unwrap()
            .next()
            .unwrap()
            .unwrap_err();

        assert!(matches!(error, Error::DuplicateHeader { column } if column == "k"));

        let entries = Options {
            mode: Some(Mode::Entries),
            ..Options::csv()
        };
        let row = Reader::from_bytes(b"k,k\n1,2\n", entries)
            .unwrap()
            .next()
            .unwrap()
            .unwrap();

        assert_eq!(
            row.to_entries(),
            [("k".into(), "1".into(), 0), ("k".into(), "2".into(), 1)]
        );
    }
}
