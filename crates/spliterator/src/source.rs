//! Opening a source: the compressed-sibling lookup for paths, and decompression by magic bytes for everything.

use std::fs::File;
use std::io::{self, Cursor, Read};
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

/// Bytes read from a file or stream per call.
pub(crate) const READ_CHUNK: usize = 64 * 1024;

const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];
const GZIP_MAGIC: [u8; 2] = [0x1F, 0x8B];

/// The extensions the sibling lookup tries, in order.
pub const COMPRESSED_EXTENSIONS: [&str; 2] = [".zst", ".gz"];

/// A compression format a source can arrive in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Compression {
    Zstd,
    Gzip,
}

/// The compression format `bytes` begins with, if any. Delimited text cannot begin with either magic: `0x8B` and
/// `0xB5` are UTF-8 continuation bytes and cannot follow `0x1F` or `0x28` in valid text.
pub fn sniff_compression(bytes: &[u8]) -> Option<Compression> {
    if bytes.starts_with(&ZSTD_MAGIC) {
        Some(Compression::Zstd)
    } else if bytes.starts_with(&GZIP_MAGIC) {
        Some(Compression::Gzip)
    } else {
        None
    }
}

/// Where a reader's bytes come from.
pub enum Source {
    /// A file, subject to the compressed-sibling lookup.
    Path(PathBuf),
    /// Bytes already in memory.
    Bytes(Vec<u8>),
    /// Any reader: a socket, a pipe, a child's stdout.
    Reader(Box<dyn Read + Send>),
}

impl From<&Path> for Source {
    fn from(path: &Path) -> Self {
        Source::Path(path.to_path_buf())
    }
}

impl From<PathBuf> for Source {
    fn from(path: PathBuf) -> Self {
        Source::Path(path)
    }
}

impl From<&str> for Source {
    /// A string is a path, as it is for `fromAsync` in the TypeScript package. Use [`Source::Bytes`] for text.
    fn from(path: &str) -> Self {
        Source::Path(PathBuf::from(path))
    }
}

impl From<Vec<u8>> for Source {
    fn from(bytes: Vec<u8>) -> Self {
        Source::Bytes(bytes)
    }
}

impl From<&[u8]> for Source {
    fn from(bytes: &[u8]) -> Self {
        Source::Bytes(bytes.to_vec())
    }
}

/// How a source is opened. Shared by every reader's options.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenOptions {
    /// Decompress a source that begins with the zstd or gzip magic bytes. Default `true`.
    pub decompress: bool,
    /// Read `path.zst`, or failing that `path.gz`, in place of a path when one exists. Default `true`.
    pub prefer_compressed: bool,
}

impl Default for OpenOptions {
    fn default() -> Self {
        OpenOptions {
            decompress: true,
            prefer_compressed: true,
        }
    }
}

/// The path a delimited file is read from: `path.zst` when it exists, else `path.gz` when it exists, else `path`. A
/// path that already names a compressed file is returned unchanged.
pub fn resolve_compressed_sibling(path: &Path) -> PathBuf {
    let text = path.as_os_str().to_string_lossy();

    if COMPRESSED_EXTENSIONS
        .iter()
        .any(|extension| text.ends_with(extension))
    {
        return path.to_path_buf();
    }

    for extension in COMPRESSED_EXTENSIONS {
        let mut candidate = path.as_os_str().to_owned();
        candidate.push(extension);
        let candidate = PathBuf::from(candidate);

        if candidate.is_file() {
            return candidate;
        }
    }

    path.to_path_buf()
}

/// Open `source` as a stream of its content: the sibling resolved, the compression removed.
pub fn open(source: Source, options: OpenOptions) -> Result<Box<dyn Read + Send>> {
    let raw: Box<dyn Read + Send> = match source {
        Source::Path(path) => {
            let path = if options.prefer_compressed {
                resolve_compressed_sibling(&path)
            } else {
                path
            };

            Box::new(File::open(path)?)
        }
        Source::Bytes(bytes) => Box::new(Cursor::new(bytes)),
        Source::Reader(reader) => reader,
    };

    if !options.decompress {
        return Ok(raw);
    }

    let (head, raw) = read_head(raw, ZSTD_MAGIC.len())?;
    let format = sniff_compression(&head);
    // The head goes back in front of the rest, so nothing read for sniffing is lost.
    let stream = Cursor::new(head).chain(raw);

    match format {
        None => Ok(Box::new(stream)),
        Some(format) => decompressor(format, stream),
    }
}

/// Up to `length` bytes from the front of `reader`, read across as many calls as a trickling stream needs.
fn read_head<R: Read>(mut reader: R, length: usize) -> io::Result<(Vec<u8>, R)> {
    let mut head = vec![0; length];
    let mut filled = 0;

    while filled < length {
        match reader.read(&mut head[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }

    head.truncate(filled);

    Ok((head, reader))
}

fn decompressor<R: Read + Send + 'static>(
    format: Compression,
    reader: R,
) -> Result<Box<dyn Read + Send>> {
    match format {
        #[cfg(feature = "zstd")]
        // Reads every frame of a multi-frame stream, and passes over skippable frames.
        Compression::Zstd => Ok(Box::new(zstd::stream::read::Decoder::new(reader)?)),
        #[cfg(feature = "gzip")]
        // Reads every member of a multi-member stream, as `gunzip` does.
        Compression::Gzip => Ok(Box::new(flate2::read::MultiGzDecoder::new(reader))),
        #[allow(unreachable_patterns)]
        other => Err(Error::Io(io::Error::new(
            io::ErrorKind::Unsupported,
            format!("the source is {other:?}-compressed and this build was compiled without that format's feature"),
        ))),
    }
}
