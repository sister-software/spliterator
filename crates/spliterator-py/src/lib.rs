//! The native half of the `spliterator` Python package: batch iterators over the `spliterator` crate's readers.
//!
//! Rows cross into Python a batch at a time (about a read chunk of input, or `BATCH_ROWS` rows), never one call per
//! row, and each batch is read with the interpreter released. The Python half (`python/spliterator`) flattens the
//! batches, parses JSON, applies transformers and owns the public signatures.

use std::io::{self, Read};
use std::path::PathBuf;
use std::sync::Mutex;

use pyo3::exceptions::{PyStopIteration, PyTypeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict, PyList, PyString, PyTuple};
use spliterator::{csv, jsonl, open, text, Error, OpenOptions, Source};

/// Rows per batch at most.
const BATCH_ROWS: usize = 4096;

/// Input bytes per batch, roughly: a batch closes once its rows hold this much text.
const BATCH_BYTES: usize = 64 * 1024;

/// A Python binary file object, read through its `read` method.
struct PyReader {
    file: Py<PyAny>,
    /// Bytes `read` returned beyond what the last call asked for.
    pending: Vec<u8>,
}

impl Read for PyReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.pending.is_empty() {
            let chunk = Python::attach(|py| -> PyResult<Vec<u8>> {
                let data = self.file.call_method1(py, "read", (buffer.len(),))?;
                let data = data.bind(py);

                if let Ok(bytes) = data.cast::<PyBytes>() {
                    return Ok(bytes.as_bytes().to_vec());
                }

                if data.is_none() {
                    // A non-blocking stream with nothing ready; treat it as the end, as `io.BufferedReader` would.
                    return Ok(Vec::new());
                }

                Err(PyTypeError::new_err(
                    "the file returned text; open it in binary mode ('rb')",
                ))
            })
            .map_err(|error| io::Error::other(error.to_string()))?;

            self.pending = chunk;
        }

        let length = self.pending.len().min(buffer.len());

        buffer[..length].copy_from_slice(&self.pending[..length]);
        self.pending.drain(..length);

        Ok(length)
    }
}

fn to_source(source: &Bound<'_, PyAny>) -> PyResult<Source> {
    if let Ok(bytes) = source.cast::<PyBytes>() {
        return Ok(Source::Bytes(bytes.as_bytes().to_vec()));
    }

    if source.hasattr("read")? {
        return Ok(Source::Reader(Box::new(PyReader {
            file: source.clone().unbind(),
            pending: Vec::new(),
        })));
    }

    let path: PathBuf = source.extract()?;

    Ok(Source::Path(path))
}

fn to_py_error(py: Python<'_>, error: Error) -> PyErr {
    let errors = match py.import("spliterator._errors") {
        Ok(module) => module,
        Err(import_error) => return import_error,
    };

    let message = error.to_string();

    let raised = match error {
        Error::Io(error) => return PyErr::from(error),
        Error::InvalidOptions(_) => return PyValueError::new_err(message),
        Error::UnterminatedQuote { byte_offset } => errors
            .getattr("UnterminatedQuoteError")
            .and_then(|class| class.call1((message, byte_offset))),
        Error::DuplicateHeader { column } => errors
            .getattr("DuplicateHeaderError")
            .and_then(|class| class.call1((message, column))),
        Error::JsonRow { row, .. } => errors
            .getattr("JSONRowError")
            .and_then(|class| class.call1((message, row))),
    };

    match raised {
        Ok(instance) => PyErr::from_value(instance),
        Err(error) => error,
    }
}

/// Rows read ahead of an error are handed out first; the error waits for the next batch.
///
/// Always boxed inside a `#[pyclass]`: the readers hold `memchr` searchers with 32-byte alignment, and Python allocates
/// objects at 16.
struct Batcher<I> {
    rows: I,
    pending_error: Option<Error>,
    finished: bool,
}

impl<T, I: Iterator<Item = spliterator::Result<T>>> Batcher<I> {
    fn new(rows: I) -> Self {
        Batcher {
            rows,
            pending_error: None,
            finished: false,
        }
    }

    /// The next batch, `Ok(None)` at the end. `weight` estimates a row's size in bytes.
    fn next_batch(&mut self, weight: impl Fn(&T) -> usize) -> Result<Option<Vec<T>>, Error> {
        if let Some(error) = self.pending_error.take() {
            self.finished = true;

            return Err(error);
        }

        if self.finished {
            return Ok(None);
        }

        let mut batch = Vec::new();
        let mut bytes = 0;

        while batch.len() < BATCH_ROWS && bytes < BATCH_BYTES {
            match self.rows.next() {
                Some(Ok(row)) => {
                    bytes += weight(&row);
                    batch.push(row);
                }
                Some(Err(error)) => {
                    if batch.is_empty() {
                        self.finished = true;

                        return Err(error);
                    }

                    self.pending_error = Some(error);

                    break;
                }
                None => {
                    self.finished = true;

                    break;
                }
            }
        }

        Ok(if batch.is_empty() { None } else { Some(batch) })
    }
}

type BoxedRead = Box<dyn Read + Send>;

fn open_options(decompress: bool, prefer_compressed: bool) -> OpenOptions {
    OpenOptions {
        decompress,
        prefer_compressed,
    }
}

fn stop() -> PyErr {
    PyStopIteration::new_err(())
}

/// Text rows, in batches of `str`.
#[pyclass(module = "spliterator._native")]
struct TextBatches {
    inner: Mutex<Box<Batcher<text::Reader<BoxedRead>>>>,
}

#[pymethods]
impl TextBatches {
    #[new]
    #[pyo3(signature = (
        source, delimiter, trim, skip_empty, crlf, drop, take, enable_quote_handling, allow_unterminated_quote,
        decompress, prefer_compressed
    ))]
    #[allow(clippy::too_many_arguments)]
    fn new(
        py: Python<'_>,
        source: &Bound<'_, PyAny>,
        delimiter: Vec<u8>,
        trim: bool,
        skip_empty: bool,
        crlf: bool,
        drop: usize,
        take: Option<usize>,
        enable_quote_handling: bool,
        allow_unterminated_quote: bool,
        decompress: bool,
        prefer_compressed: bool,
    ) -> PyResult<Self> {
        let options = text::Options {
            delimiter,
            trim,
            skip_empty,
            crlf,
            drop,
            take,
            enable_quote_handling,
            allow_unterminated_quote,
            open: open_options(decompress, prefer_compressed),
        };

        let source = to_source(source)?;
        let reader = py
            .detach(|| {
                open(source, options.open).and_then(|reader| text::Reader::new(reader, options))
            })
            .map_err(|error| to_py_error(py, error))?;

        Ok(TextBatches {
            inner: Mutex::new(Box::new(Batcher::new(reader))),
        })
    }

    fn __iter__(slf: PyRef<'_, Self>) -> PyRef<'_, Self> {
        slf
    }

    fn __next__<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
        let mut inner = self
            .inner
            .lock()
            .expect("a batch iterator is not shared across threads mid-read");
        let batcher = &mut **inner;
        let batch = py
            .detach(|| batcher.next_batch(String::len))
            .map_err(|error| to_py_error(py, error))?;

        match batch {
            Some(rows) => PyList::new(py, rows),
            None => Err(stop()),
        }
    }
}

/// JSONL rows that reach the parser (comments, blank rows and `drop` applied, `take` honoured), as `str`. Python parses
/// them, so the values are the interpreter's own.
#[pyclass(module = "spliterator._native")]
struct JsonlRows {
    inner: Mutex<Box<Batcher<jsonl::Rows<BoxedRead>>>>,
}

#[pymethods]
impl JsonlRows {
    #[new]
    #[pyo3(signature = (source, delimiter, skip_empty, crlf, comment, drop, take, decompress, prefer_compressed))]
    #[allow(clippy::too_many_arguments)]
    fn new(
        py: Python<'_>,
        source: &Bound<'_, PyAny>,
        delimiter: Vec<u8>,
        skip_empty: bool,
        crlf: bool,
        comment: Option<Vec<String>>,
        drop: usize,
        take: Option<usize>,
        decompress: bool,
        prefer_compressed: bool,
    ) -> PyResult<Self> {
        let options = jsonl::Options {
            delimiter,
            skip_empty,
            crlf,
            comment,
            drop,
            take,
            open: open_options(decompress, prefer_compressed),
        };

        let source = to_source(source)?;
        let rows = py
            .detach(|| {
                open(source, options.open).and_then(|reader| jsonl::Rows::new(reader, &options))
            })
            .map_err(|error| to_py_error(py, error))?;

        Ok(JsonlRows {
            inner: Mutex::new(Box::new(Batcher::new(rows))),
        })
    }

    fn __iter__(slf: PyRef<'_, Self>) -> PyRef<'_, Self> {
        slf
    }

    fn __next__<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
        let mut inner = self
            .inner
            .lock()
            .expect("a batch iterator is not shared across threads mid-read");
        let batcher = &mut **inner;
        let batch = py
            .detach(|| batcher.next_batch(String::len))
            .map_err(|error| to_py_error(py, error))?;

        match batch {
            Some(rows) => PyList::new(py, rows),
            None => Err(stop()),
        }
    }
}

fn parse_mode(mode: Option<&str>) -> PyResult<Option<csv::Mode>> {
    match mode {
        None => Ok(None),
        Some("object") => Ok(Some(csv::Mode::Object)),
        Some("array") => Ok(Some(csv::Mode::Array)),
        Some("entries") => Ok(Some(csv::Mode::Entries)),
        Some(other) => Err(PyValueError::new_err(format!(
            "mode must be 'object', 'array' or 'entries', not {other:?}"
        ))),
    }
}

/// CSV, TSV or PSV rows in batches, each shaped by the mode: `dict`, `list[str]`, or `list[tuple[str, str, int]]`.
#[pyclass(module = "spliterator._native")]
struct CsvBatches {
    inner: Mutex<Box<Batcher<csv::Reader<BoxedRead>>>>,
    mode: csv::Mode,
    /// The header, as Python strings, once read. Keys are shared across rows instead of rebuilt per row.
    keys: Mutex<Option<Vec<Py<PyString>>>>,
}

#[pymethods]
impl CsvBatches {
    #[new]
    #[pyo3(signature = (
        source, row_delimiter, column_delimiter, enable_quote_handling, allow_unterminated_quote, crlf, trim,
        skip_empty, header, mode, normalize_keys, drop, take, decompress, prefer_compressed
    ))]
    #[allow(clippy::too_many_arguments)]
    fn new(
        py: Python<'_>,
        source: &Bound<'_, PyAny>,
        row_delimiter: Vec<u8>,
        column_delimiter: Vec<u8>,
        enable_quote_handling: bool,
        allow_unterminated_quote: bool,
        crlf: bool,
        trim: bool,
        skip_empty: bool,
        header: bool,
        mode: Option<&str>,
        normalize_keys: bool,
        drop: usize,
        take: Option<usize>,
        decompress: bool,
        prefer_compressed: bool,
    ) -> PyResult<Self> {
        let options = csv::Options {
            row_delimiter,
            column_delimiter,
            enable_quote_handling,
            allow_unterminated_quote,
            crlf,
            trim,
            skip_empty,
            header,
            mode: parse_mode(mode)?,
            normalize_keys,
            drop,
            take,
            open: open_options(decompress, prefer_compressed),
        };

        let mode = options.resolved_mode();
        let source = to_source(source)?;
        let reader = py
            .detach(|| {
                open(source, options.open).and_then(|reader| csv::Reader::new(reader, options))
            })
            .map_err(|error| to_py_error(py, error))?;

        Ok(CsvBatches {
            inner: Mutex::new(Box::new(Batcher::new(reader))),
            mode,
            keys: Mutex::new(None),
        })
    }

    /// The header row as keys, once the first row has been read; `None` before that and without a header.
    #[getter]
    fn headers(&self) -> Option<Vec<String>> {
        let inner = self
            .inner
            .lock()
            .expect("a batch iterator is not shared across threads mid-read");

        inner.rows.headers().map(<[String]>::to_vec)
    }

    fn __iter__(slf: PyRef<'_, Self>) -> PyRef<'_, Self> {
        slf
    }

    fn __next__<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
        let mut inner = self
            .inner
            .lock()
            .expect("a batch iterator is not shared across threads mid-read");
        let batcher = &mut **inner;
        let batch = py
            .detach(|| {
                batcher.next_batch(|row: &csv::Row| {
                    row.cells.iter().map(String::len).sum::<usize>() + row.cells.len()
                })
            })
            .map_err(|error| to_py_error(py, error))?;

        let Some(rows) = batch else {
            return Err(stop());
        };

        let output = PyList::empty(py);
        let mut keys = self
            .keys
            .lock()
            .expect("a batch iterator is not shared across threads mid-read");

        if keys.is_none() {
            if let Some(headers) = inner.rows.headers() {
                *keys = Some(
                    headers
                        .iter()
                        .map(|header| PyString::new(py, header).unbind())
                        .collect(),
                );
            }
        }

        let header_keys: &[Py<PyString>] = keys.as_deref().unwrap_or(&[]);

        for row in rows {
            match self.mode {
                csv::Mode::Array => output.append(PyList::new(py, row.cells)?)?,
                csv::Mode::Object => {
                    let record = PyDict::new(py);

                    for (index, value) in row.cells.iter().enumerate() {
                        match header_keys.get(index) {
                            Some(key) => record.set_item(key.bind(py), value)?,
                            None => record.set_item(format!("column_{index}"), value)?,
                        }
                    }

                    for key in header_keys.iter().skip(row.cells.len()) {
                        record.set_item(key.bind(py), "")?;
                    }

                    output.append(record)?;
                }
                csv::Mode::Entries => {
                    let entries = PyList::empty(py);

                    for (key, value, index) in row.to_entries() {
                        entries.append(PyTuple::new(
                            py,
                            [
                                key.into_pyobject(py)?.into_any(),
                                value.into_pyobject(py)?.into_any(),
                                index.into_pyobject(py)?.into_any(),
                            ],
                        )?)?;
                    }

                    output.append(entries)?;
                }
            }
        }

        Ok(output)
    }
}

#[pymodule]
fn _native(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_class::<TextBatches>()?;
    module.add_class::<JsonlRows>()?;
    module.add_class::<CsvBatches>()?;

    Ok(())
}
