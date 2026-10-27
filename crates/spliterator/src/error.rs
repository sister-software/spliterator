//! The errors every reader returns.

use std::fmt;
use std::io;

/// A reader's error. The variants mirror the TypeScript package's error classes, so the same malformed input fails the
/// same way in every language.
#[derive(Debug)]
pub enum Error {
    /// The source could not be opened or read, or failed to decompress.
    Io(io::Error),
    /// Input ended inside a double-quoted region. `byte_offset` is where the record holding the open quote starts, in
    /// the decompressed input.
    UnterminatedQuote { byte_offset: u64 },
    /// A header row named the same column twice while rows are keyed by name.
    DuplicateHeader { column: String },
    /// A JSONL row failed to parse. `row` is the zero-based index of the row among those that reached the parser,
    /// after empty, blank and comment rows were skipped and after `drop`.
    #[cfg(feature = "json")]
    JsonRow {
        row: usize,
        source: serde_json::Error,
    },
    /// An option the reader cannot honour, such as an empty delimiter.
    InvalidOptions(String),
}

/// The result type of every reader.
pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Io(error) => write!(f, "{error}"),
            Error::UnterminatedQuote { byte_offset } => write!(
                f,
                "Input ended inside a quoted region opened in the record at byte {byte_offset}. A quote that never \
                 closes swallows every later record; set `allow_unterminated_quote` to read it anyway."
            ),
            Error::DuplicateHeader { column } => write!(
                f,
                "The header repeats the column \"{column}\", so object rows would lose one of its values. Normalize \
                 keys to suffix repeats, or read rows as arrays or entries."
            ),
            #[cfg(feature = "json")]
            Error::JsonRow { row, source } => write!(f, "Failed to parse JSON at row {row}: {source}"),
            Error::InvalidOptions(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Io(error) => Some(error),
            #[cfg(feature = "json")]
            Error::JsonRow { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Error::Io(error)
    }
}
