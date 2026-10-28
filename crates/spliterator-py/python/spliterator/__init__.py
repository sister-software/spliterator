"""Streaming readers for delimited text, CSV, TSV, PSV and JSONL.

The Python counterpart of the ``spliterator`` npm package and Rust crate. All three read the same input into the same
rows: the same defaults, the same trimming, the same quote rules and the same errors. The contract is the conformance
suite in the repository's ``conformance/`` directory, which this package's tests run.

A source is a path (``str`` or ``os.PathLike``), bytes-like data, or a binary file object. A path reads ``path.zst`` or
``path.gz`` in its place when one exists (``prefer_compressed``), and any source beginning with the zstd or gzip magic
bytes is decompressed before it is split (``decompress``). Nothing is opened until the first row is pulled.

Every reader has an async twin (``aread_text``, ``aread_csv``, …) that reads each batch of rows on a worker thread, and
text and the CSV family have counts (``count_text``, ``count_csv``, …) that equal the number of rows the reader yields.

>>> import spliterator
>>> list(spliterator.read_csv(b"name,age\\nAda,36\\n"))
[{'name': 'Ada', 'age': '36'}]
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator, Callable, Iterable, Iterator, Mapping
from importlib.metadata import PackageNotFoundError, version
from typing import Any, Literal, TypeAlias, TypedDict, TypeVar, Unpack

from . import _native
from ._errors import DuplicateHeaderError, JSONRowError, SpliteratorError, UnterminatedQuoteError
from ._types import SupportsRead

__all__ = [
    "CSVOptions",
    "DuplicateHeaderError",
    "JSONLOptions",
    "JSONRowError",
    "Source",
    "SpliteratorError",
    "SupportsRead",
    "TextOptions",
    "UnterminatedQuoteError",
    "aread_csv",
    "aread_jsonl",
    "aread_psv",
    "aread_text",
    "aread_tsv",
    "count_csv",
    "count_psv",
    "count_text",
    "count_tsv",
    "read_csv",
    "read_jsonl",
    "read_psv",
    "read_text",
    "read_tsv",
]

try:
    __version__ = version("sister-software-spliterator")
except PackageNotFoundError:  # pragma: no cover - a source checkout without an install
    __version__ = "0.0.0"

Source: TypeAlias = str | os.PathLike[str] | bytes | bytearray | memoryview | SupportsRead
"""A path, bytes-like data, or a binary stream (anything with ``read(size) -> bytes``)."""

Mode: TypeAlias = Literal["object", "array", "entries"]

Delimiter: TypeAlias = str | bytes

Transformers: TypeAlias = Mapping[str, Callable[[str], Any]]

T = TypeVar("T")


class TextOptions(TypedDict, total=False):
    """Options for :func:`read_text`, :func:`aread_text` and :func:`count_text`."""

    delimiter: Delimiter
    """The record delimiter. Default ``"\\n"``."""
    trim: bool
    """Strip the ECMAScript whitespace set (not ``str.strip``'s) from each row. Default ``True``."""
    skip_empty: bool
    """Drop empty records, and with ``trim`` rows that trim to nothing. Default ``True``."""
    crlf: bool
    """Treat one ``\\r`` before a delimiter as part of it. Default ``False``; ``trim`` removes it anyway."""
    drop: int
    """Rows to skip, counted after skipping. Default ``0``."""
    take: int | None
    """Rows to yield at most, counted after skipping. Default unlimited."""
    enable_quote_handling: bool
    """Keep a delimiter inside ``"…"`` from splitting. Default ``False``."""
    allow_unterminated_quote: bool
    """Read input ending inside quotes instead of raising :class:`UnterminatedQuoteError`. Default ``False``."""
    decompress: bool
    """Decompress a source beginning with the zstd or gzip magic bytes. Default ``True``."""
    prefer_compressed: bool
    """Read ``path.zst`` or ``path.gz`` in place of ``path`` when one exists. Default ``True``."""


class JSONLOptions(TypedDict, total=False):
    """Options for :func:`read_jsonl` and :func:`aread_jsonl`."""

    delimiter: Delimiter
    """The record delimiter. Default ``"\\n"``."""
    skip_empty: bool
    """Skip empty and whitespace-only rows. Default ``True``."""
    crlf: bool
    """Treat one ``\\r`` before a delimiter as part of it. Default ``False``."""
    comment: str | list[str] | None
    """Skip rows whose first non-whitespace text starts with one of these prefixes. Default none."""
    drop: int
    """Rows to skip, counted after skipping. Default ``0``."""
    take: int | None
    """Rows to parse at most, counted after skipping. Default unlimited."""
    decompress: bool
    """Decompress a source beginning with the zstd or gzip magic bytes. Default ``True``."""
    prefer_compressed: bool
    """Read ``path.zst`` or ``path.gz`` in place of ``path`` when one exists. Default ``True``."""


class CSVOptions(TypedDict, total=False):
    """Options for the CSV, TSV and PSV readers and counts. The defaults shown are CSV's."""

    column_delimiter: Delimiter
    """The column delimiter: ``","`` for CSV, ``"\\t"`` for TSV, ``"|"`` for PSV."""
    delimiter: Delimiter
    """The row delimiter. Default ``"\\n"``."""
    header: bool
    """Take the first record as the header. Default ``True``."""
    mode: Mode | None
    """``"object"`` (default with a header), ``"array"`` (default without), or ``"entries"``."""
    normalize_keys: bool
    """Snake-case header names and suffix repeats. Default ``False``."""
    enable_quote_handling: bool
    """Keep delimiters inside ``"…"`` from splitting and unquote cells. ``True`` for CSV and PSV, ``False`` for TSV."""
    allow_unterminated_quote: bool
    """Read input ending inside quotes instead of raising :class:`UnterminatedQuoteError`. Default ``False``."""
    crlf: bool
    """Treat one ``\\r`` before a row delimiter as part of it. Default ``True``."""
    trim: bool
    """Trim each cell, header included, after unquoting. Default ``True``."""
    skip_empty: bool
    """Drop records whose bytes are empty after CRLF removal. Default ``True``."""
    drop: int
    """Data rows to skip. Default ``0``."""
    take: int | None
    """Data rows to yield at most. Default unlimited."""
    transformers: Transformers | None
    """Functions applied by header name to object and entries rows, after trimming. Default none."""
    decompress: bool
    """Decompress a source beginning with the zstd or gzip magic bytes. Default ``True``."""
    prefer_compressed: bool
    """Read ``path.zst`` or ``path.gz`` in place of ``path`` when one exists. Default ``True``."""


_TEXT_DEFAULTS: TextOptions = {
    "delimiter": "\n",
    "trim": True,
    "skip_empty": True,
    "crlf": False,
    "drop": 0,
    "take": None,
    "enable_quote_handling": False,
    "allow_unterminated_quote": False,
    "decompress": True,
    "prefer_compressed": True,
}

_JSONL_DEFAULTS: JSONLOptions = {
    "delimiter": "\n",
    "skip_empty": True,
    "crlf": False,
    "comment": None,
    "drop": 0,
    "take": None,
    "decompress": True,
    "prefer_compressed": True,
}

_CSV_DEFAULTS: CSVOptions = {
    "column_delimiter": ",",
    "delimiter": "\n",
    "header": True,
    "mode": None,
    "normalize_keys": False,
    "enable_quote_handling": True,
    "allow_unterminated_quote": False,
    "crlf": True,
    "trim": True,
    "skip_empty": True,
    "drop": 0,
    "take": None,
    "transformers": None,
    "decompress": True,
    "prefer_compressed": True,
}

_TSV_DEFAULTS: CSVOptions = {**_CSV_DEFAULTS, "column_delimiter": "\t", "enable_quote_handling": False}

_PSV_DEFAULTS: CSVOptions = {**_CSV_DEFAULTS, "column_delimiter": "|"}


def _merge(defaults: Mapping[str, Any], options: Mapping[str, Any], reader: str) -> dict[str, Any]:
    unknown = options.keys() - defaults.keys()

    if unknown:
        raise TypeError(f"{reader}() got unexpected keyword arguments: {', '.join(sorted(unknown))}")

    return {**defaults, **options}


def _source(source: Source) -> str | bytes | SupportsRead:
    if isinstance(source, (bytes, bytearray, memoryview)):
        return bytes(source)

    if isinstance(source, (str, os.PathLike)):
        return os.fspath(source)

    return source


def _delimiter(value: Delimiter) -> bytes:
    return value.encode("utf-8") if isinstance(value, str) else bytes(value)


def _flatten(batches: Iterable[list[T]]) -> Iterator[T]:
    for batch in batches:
        yield from batch


async def _aflatten(open_batches: Callable[[], Iterator[list[T]]]) -> AsyncIterator[T]:
    # Opening a path and reading a batch both block, so both happen on a worker thread; the rows are handed out here.
    batches = await asyncio.to_thread(open_batches)

    while (batch := await asyncio.to_thread(next, batches, None)) is not None:
        for row in batch:
            yield row


# --- text -------------------------------------------------------------------------------------------------------------


def _text_batches(source: Source, options: Mapping[str, Any]) -> _native.TextBatches:
    o = _merge(_TEXT_DEFAULTS, options, "read_text")

    return _native.TextBatches(
        _source(source),
        _delimiter(o["delimiter"]),
        o["trim"],
        o["skip_empty"],
        o["crlf"],
        o["drop"],
        o["take"],
        o["enable_quote_handling"],
        o["allow_unterminated_quote"],
        o["decompress"],
        o["prefer_compressed"],
    )


def read_text(source: Source, **options: Unpack[TextOptions]) -> Iterator[str]:
    """Yield the rows of a delimited text source.

    Each record is decoded as UTF-8 (each invalid sequence becomes U+FFFD) with one leading BOM removed. ``trim`` (on by
    default) strips the ECMAScript whitespace set, not ``str.strip``'s, and with ``skip_empty`` a row that trims to
    nothing is dropped. ``drop`` and ``take`` count the rows yielded.
    """
    yield from _flatten(_text_batches(source, options))


def aread_text(source: Source, **options: Unpack[TextOptions]) -> AsyncIterator[str]:
    """:func:`read_text`, reading each batch of rows on a worker thread."""
    return _aflatten(lambda: _text_batches(source, options))


def count_text(source: Source, **options: Unpack[TextOptions]) -> int:
    """The number of rows :func:`read_text` would yield, without building them."""
    o = _merge(_TEXT_DEFAULTS, options, "count_text")

    return _native.count_text(
        _source(source),
        _delimiter(o["delimiter"]),
        o["trim"],
        o["skip_empty"],
        o["crlf"],
        o["drop"],
        o["take"],
        o["enable_quote_handling"],
        o["allow_unterminated_quote"],
        o["decompress"],
        o["prefer_compressed"],
    )


# --- JSONL ------------------------------------------------------------------------------------------------------------


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not valid JSON")


# The standard decoder accepts NaN and Infinity; the other bindings reject them, so this one does too.
_JSON_DECODER = json.JSONDecoder(parse_constant=_reject_constant)


def _jsonl_batches(source: Source, options: Mapping[str, Any]) -> _native.JsonlRows:
    o = _merge(_JSONL_DEFAULTS, options, "read_jsonl")
    comment = o["comment"]

    return _native.JsonlRows(
        _source(source),
        _delimiter(o["delimiter"]),
        o["skip_empty"],
        o["crlf"],
        [comment] if isinstance(comment, str) else comment,
        o["drop"],
        o["take"],
        o["decompress"],
        o["prefer_compressed"],
    )


class _JSONParser:
    """Parses rows in order, numbering them for the error a malformed row raises."""

    def __init__(self) -> None:
        self.row = 0

    def __call__(self, text: str) -> Any:
        try:
            value = _JSON_DECODER.decode(text)
        except ValueError as error:
            raise JSONRowError(f"Failed to parse JSON at row {self.row}: {error}", self.row) from error

        self.row += 1

        return value


def read_jsonl(source: Source, **options: Unpack[JSONLOptions]) -> Iterator[Any]:
    """Yield each row of a JSONL source, parsed.

    Empty and whitespace-only rows are skipped. ``comment`` prefixes skip rows whose first non-whitespace text starts
    with one. ``drop`` and ``take`` count the rows that reach the parser. A row that fails to parse raises
    :class:`JSONRowError` naming its index among those rows.
    """
    parse = _JSONParser()

    for text in _flatten(_jsonl_batches(source, options)):
        yield parse(text)


async def aread_jsonl(source: Source, **options: Unpack[JSONLOptions]) -> AsyncIterator[Any]:
    """:func:`read_jsonl`, reading each batch of rows on a worker thread. Parsing happens on the event loop."""
    parse = _JSONParser()

    async for text in _aflatten(lambda: _jsonl_batches(source, options)):
        yield parse(text)


# --- CSV, TSV, PSV ----------------------------------------------------------------------------------------------------


def _csv_batches(source: Source, o: Mapping[str, Any]) -> _native.CsvBatches:
    return _native.CsvBatches(
        _source(source),
        _delimiter(o["delimiter"]),
        _delimiter(o["column_delimiter"]),
        o["enable_quote_handling"],
        o["allow_unterminated_quote"],
        o["crlf"],
        o["trim"],
        o["skip_empty"],
        o["header"],
        o["mode"],
        o["normalize_keys"],
        o["drop"],
        o["take"],
        o["decompress"],
        o["prefer_compressed"],
    )


class _Transformer:
    """Applies transformers to object and entries rows, by header name, as `CSVSpliterator` does."""

    def __init__(self, batches: _native.CsvBatches, o: Mapping[str, Any]) -> None:
        self.batches = batches
        self.mode = o["mode"] or ("object" if o["header"] else "array")
        self.transformers: Transformers | None = o["transformers"] if self.mode != "array" else None
        self.bound: dict[str, Callable[[str], Any]] | None = None

    def batch(self, rows: list[Any]) -> list[Any]:
        if not self.transformers:
            return rows

        if self.bound is None:
            headers = set(self.batches.headers or ())
            self.bound = {name: fn for name, fn in self.transformers.items() if name in headers}

        bound = self.bound

        if self.mode == "object":
            for row in rows:
                for name, transform in bound.items():
                    row[name] = transform(row[name])

            return rows

        return [
            [(key, bound[key](value) if key in bound else value, index) for key, value, index in row] for row in rows
        ]


def _transformed(source: Source, o: Mapping[str, Any]) -> Iterator[list[Any]]:
    batches = _csv_batches(source, o)
    transformer = _Transformer(batches, o)

    for batch in batches:
        yield transformer.batch(batch)


def _read_csv(source: Source, defaults: CSVOptions, options: Mapping[str, Any], reader: str) -> Iterator[Any]:
    yield from _flatten(_transformed(source, _merge(defaults, options, reader)))


def _aread_csv(source: Source, defaults: CSVOptions, options: Mapping[str, Any], reader: str) -> AsyncIterator[Any]:
    o = _merge(defaults, options, reader)

    return _aflatten(lambda: _transformed(source, o))


def _count_csv(source: Source, defaults: CSVOptions, options: Mapping[str, Any], reader: str) -> int:
    o = _merge(defaults, options, reader)

    return _native.count_csv(
        _source(source),
        _delimiter(o["delimiter"]),
        _delimiter(o["column_delimiter"]),
        o["enable_quote_handling"],
        o["allow_unterminated_quote"],
        o["crlf"],
        o["skip_empty"],
        o["header"],
        o["drop"],
        o["take"],
        o["decompress"],
        o["prefer_compressed"],
    )


def read_csv(source: Source, **options: Unpack[CSVOptions]) -> Iterator[Any]:
    """Yield the rows of a CSV source.

    With a header (the default) rows are ``dict`` keyed by the header as written; without one they are ``list[str]``.
    ``mode="entries"`` yields ``list[tuple[key, value, index]]``. A column a row lacks is ``""`` in object and entries
    rows; array rows keep a short row short. Cells past the header are keyed ``column_<index>``.

    Quoted cells are unquoted and ``""`` unescaped. Cells are trimmed after unquoting, header included. In object mode
    a repeated header raises :class:`DuplicateHeaderError` unless ``normalize_keys`` suffixes it. Input ending inside
    quotes raises :class:`UnterminatedQuoteError` after the rows before it. ``drop`` and ``take`` count data rows.
    """
    return _read_csv(source, _CSV_DEFAULTS, options, "read_csv")


def read_tsv(source: Source, **options: Unpack[CSVOptions]) -> Iterator[Any]:
    """Yield the rows of a TSV source. As :func:`read_csv`, except that the TSV format has no quoting, so a ``"`` is
    data unless ``enable_quote_handling`` is set."""
    return _read_csv(source, _TSV_DEFAULTS, options, "read_tsv")


def read_psv(source: Source, **options: Unpack[CSVOptions]) -> Iterator[Any]:
    """Yield the rows of a pipe-separated source. As :func:`read_csv`, split on ``|``."""
    return _read_csv(source, _PSV_DEFAULTS, options, "read_psv")


def aread_csv(source: Source, **options: Unpack[CSVOptions]) -> AsyncIterator[Any]:
    """:func:`read_csv`, reading each batch of rows on a worker thread."""
    return _aread_csv(source, _CSV_DEFAULTS, options, "aread_csv")


def aread_tsv(source: Source, **options: Unpack[CSVOptions]) -> AsyncIterator[Any]:
    """:func:`read_tsv`, reading each batch of rows on a worker thread."""
    return _aread_csv(source, _TSV_DEFAULTS, options, "aread_tsv")


def aread_psv(source: Source, **options: Unpack[CSVOptions]) -> AsyncIterator[Any]:
    """:func:`read_psv`, reading each batch of rows on a worker thread."""
    return _aread_csv(source, _PSV_DEFAULTS, options, "aread_psv")


def count_csv(source: Source, **options: Unpack[CSVOptions]) -> int:
    """The number of data rows :func:`read_csv` would yield, without splitting cells. The header is skipped but not
    read, so a repeated header is not an error here; ``mode``, ``normalize_keys`` and ``transformers`` are ignored."""
    return _count_csv(source, _CSV_DEFAULTS, options, "count_csv")


def count_tsv(source: Source, **options: Unpack[CSVOptions]) -> int:
    """The number of data rows :func:`read_tsv` would yield."""
    return _count_csv(source, _TSV_DEFAULTS, options, "count_tsv")


def count_psv(source: Source, **options: Unpack[CSVOptions]) -> int:
    """The number of data rows :func:`read_psv` would yield."""
    return _count_csv(source, _PSV_DEFAULTS, options, "count_psv")
