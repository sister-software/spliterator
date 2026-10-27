"""Streaming readers for delimited text, CSV, TSV, PSV and JSONL.

The Python counterpart of the ``spliterator`` npm package and Rust crate. All three read the same input into the same
rows: the same defaults, the same trimming, the same quote rules and the same errors. The contract is the conformance
suite in the repository's ``conformance/`` directory, which this package's tests run.

A source is a path (``str`` or ``os.PathLike``), bytes-like data, or a binary file object. A path reads ``path.zst`` or
``path.gz`` in its place when one exists (``prefer_compressed``), and any source beginning with the zstd or gzip magic
bytes is decompressed before it is split (``decompress``). Nothing is opened until the first row is pulled.

>>> import spliterator
>>> list(spliterator.read_csv(b"name,age\\nAda,36\\n"))
[{'name': 'Ada', 'age': '36'}]
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Iterator, Mapping
from importlib.metadata import PackageNotFoundError, version
from typing import Any, BinaryIO, Literal, TypeAlias

from . import _native
from ._errors import DuplicateHeaderError, JSONRowError, SpliteratorError, UnterminatedQuoteError

__all__ = [
    "DuplicateHeaderError",
    "JSONRowError",
    "Source",
    "SpliteratorError",
    "UnterminatedQuoteError",
    "read_csv",
    "read_jsonl",
    "read_psv",
    "read_text",
    "read_tsv",
]

try:
    __version__ = version("spliterator-py")
except PackageNotFoundError:  # pragma: no cover - a source checkout without an install
    __version__ = "0.0.0"

Source: TypeAlias = str | os.PathLike[str] | bytes | bytearray | memoryview | BinaryIO
"""A path, bytes-like data, or a binary file object."""

Mode: TypeAlias = Literal["object", "array", "entries"]

Delimiter: TypeAlias = str | bytes


def _source(source: Source) -> str | bytes | BinaryIO:
    if isinstance(source, (bytes, bytearray, memoryview)):
        return bytes(source)

    if isinstance(source, (str, os.PathLike)):
        return os.fspath(source)

    return source


def _delimiter(value: Delimiter) -> bytes:
    return value.encode("utf-8") if isinstance(value, str) else bytes(value)


def read_text(
    source: Source,
    *,
    delimiter: Delimiter = "\n",
    trim: bool = True,
    skip_empty: bool = True,
    crlf: bool = False,
    drop: int = 0,
    take: int | None = None,
    enable_quote_handling: bool = False,
    allow_unterminated_quote: bool = False,
    decompress: bool = True,
    prefer_compressed: bool = True,
) -> Iterator[str]:
    """Yield the rows of a delimited text source.

    Each record is decoded as UTF-8 (each invalid sequence becomes U+FFFD) with one leading BOM removed. ``trim`` (on by
    default) strips the ECMAScript whitespace set, not ``str.strip``'s, and with ``skip_empty`` a row that trims to
    nothing is dropped. ``drop`` and ``take`` count the rows yielded.
    """
    batches = _native.TextBatches(
        _source(source),
        _delimiter(delimiter),
        trim,
        skip_empty,
        crlf,
        drop,
        take,
        enable_quote_handling,
        allow_unterminated_quote,
        decompress,
        prefer_compressed,
    )

    for batch in batches:
        yield from batch


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not valid JSON")


# The standard decoder accepts NaN and Infinity; the other bindings reject them, so this one does too.
_JSON_DECODER = json.JSONDecoder(parse_constant=_reject_constant)


def read_jsonl(
    source: Source,
    *,
    delimiter: Delimiter = "\n",
    skip_empty: bool = True,
    crlf: bool = False,
    comment: str | list[str] | None = None,
    drop: int = 0,
    take: int | None = None,
    decompress: bool = True,
    prefer_compressed: bool = True,
) -> Iterator[Any]:
    """Yield each row of a JSONL source, parsed.

    Empty and whitespace-only rows are skipped. ``comment`` prefixes skip rows whose first non-whitespace text starts
    with one. ``drop`` and ``take`` count the rows that reach the parser. A row that fails to parse raises
    :class:`JSONRowError` naming its index among those rows.
    """
    comments = [comment] if isinstance(comment, str) else comment
    batches = _native.JsonlRows(
        _source(source),
        _delimiter(delimiter),
        skip_empty,
        crlf,
        comments,
        drop,
        take,
        decompress,
        prefer_compressed,
    )
    row = 0

    for batch in batches:
        for text in batch:
            try:
                value = _JSON_DECODER.decode(text)
            except ValueError as error:
                raise JSONRowError(f"Failed to parse JSON at row {row}: {error}", row) from error

            yield value
            row += 1


Transformers: TypeAlias = Mapping[str, Callable[[str], Any]]


def _read_delimited(
    source: Source,
    *,
    column_delimiter: Delimiter,
    delimiter: Delimiter,
    header: bool,
    mode: Mode | None,
    normalize_keys: bool,
    enable_quote_handling: bool,
    allow_unterminated_quote: bool,
    crlf: bool,
    trim: bool,
    skip_empty: bool,
    drop: int,
    take: int | None,
    transformers: Transformers | None,
    decompress: bool,
    prefer_compressed: bool,
) -> Iterator[Any]:
    batches = _native.CsvBatches(
        _source(source),
        _delimiter(delimiter),
        _delimiter(column_delimiter),
        enable_quote_handling,
        allow_unterminated_quote,
        crlf,
        trim,
        skip_empty,
        header,
        mode,
        normalize_keys,
        drop,
        take,
        decompress,
        prefer_compressed,
    )
    resolved_mode = mode or ("object" if header else "array")

    # Transformers bind to header names and apply to object and entries rows, as `CSVSpliterator`'s do.
    if not transformers or resolved_mode == "array":
        for batch in batches:
            yield from batch

        return

    bound: dict[str, Callable[[str], Any]] | None = None

    for batch in batches:
        if bound is None:
            headers = set(batches.headers or ())
            bound = {name: transform for name, transform in transformers.items() if name in headers}

        for row in batch:
            if resolved_mode == "object":
                for name, transform in bound.items():
                    row[name] = transform(row[name])
            else:
                row = [(key, bound[key](value) if key in bound else value, index) for key, value, index in row]

            yield row


def read_csv(
    source: Source,
    *,
    column_delimiter: Delimiter = ",",
    delimiter: Delimiter = "\n",
    header: bool = True,
    mode: Mode | None = None,
    normalize_keys: bool = False,
    enable_quote_handling: bool = True,
    allow_unterminated_quote: bool = False,
    crlf: bool = True,
    trim: bool = True,
    skip_empty: bool = True,
    drop: int = 0,
    take: int | None = None,
    transformers: Transformers | None = None,
    decompress: bool = True,
    prefer_compressed: bool = True,
) -> Iterator[Any]:
    """Yield the rows of a CSV source.

    With a header (the default) rows are ``dict`` keyed by the header as written; without one they are ``list[str]``.
    ``mode="entries"`` yields ``list[tuple[key, value, index]]``. A column a row lacks is ``""`` in object and entries
    rows; array rows keep a short row short. Cells past the header are keyed ``column_<index>``.

    Quoted cells are unquoted and ``""`` unescaped. Cells are trimmed after unquoting, header included. In object mode
    a repeated header raises :class:`DuplicateHeaderError` unless ``normalize_keys`` suffixes it. Input ending inside
    quotes raises :class:`UnterminatedQuoteError` after the rows before it. ``drop`` and ``take`` count data rows.
    """
    return _read_delimited(
        source,
        column_delimiter=column_delimiter,
        delimiter=delimiter,
        header=header,
        mode=mode,
        normalize_keys=normalize_keys,
        enable_quote_handling=enable_quote_handling,
        allow_unterminated_quote=allow_unterminated_quote,
        crlf=crlf,
        trim=trim,
        skip_empty=skip_empty,
        drop=drop,
        take=take,
        transformers=transformers,
        decompress=decompress,
        prefer_compressed=prefer_compressed,
    )


def read_tsv(
    source: Source,
    *,
    column_delimiter: Delimiter = "\t",
    delimiter: Delimiter = "\n",
    header: bool = True,
    mode: Mode | None = None,
    normalize_keys: bool = False,
    enable_quote_handling: bool = False,
    allow_unterminated_quote: bool = False,
    crlf: bool = True,
    trim: bool = True,
    skip_empty: bool = True,
    drop: int = 0,
    take: int | None = None,
    transformers: Transformers | None = None,
    decompress: bool = True,
    prefer_compressed: bool = True,
) -> Iterator[Any]:
    """Yield the rows of a TSV source. As :func:`read_csv`, except that the TSV format has no quoting, so a ``"`` is
    data unless ``enable_quote_handling`` is set."""
    return _read_delimited(
        source,
        column_delimiter=column_delimiter,
        delimiter=delimiter,
        header=header,
        mode=mode,
        normalize_keys=normalize_keys,
        enable_quote_handling=enable_quote_handling,
        allow_unterminated_quote=allow_unterminated_quote,
        crlf=crlf,
        trim=trim,
        skip_empty=skip_empty,
        drop=drop,
        take=take,
        transformers=transformers,
        decompress=decompress,
        prefer_compressed=prefer_compressed,
    )


def read_psv(
    source: Source,
    *,
    column_delimiter: Delimiter = "|",
    delimiter: Delimiter = "\n",
    header: bool = True,
    mode: Mode | None = None,
    normalize_keys: bool = False,
    enable_quote_handling: bool = True,
    allow_unterminated_quote: bool = False,
    crlf: bool = True,
    trim: bool = True,
    skip_empty: bool = True,
    drop: int = 0,
    take: int | None = None,
    transformers: Transformers | None = None,
    decompress: bool = True,
    prefer_compressed: bool = True,
) -> Iterator[Any]:
    """Yield the rows of a pipe-separated source. As :func:`read_csv`, split on ``|``."""
    return _read_delimited(
        source,
        column_delimiter=column_delimiter,
        delimiter=delimiter,
        header=header,
        mode=mode,
        normalize_keys=normalize_keys,
        enable_quote_handling=enable_quote_handling,
        allow_unterminated_quote=allow_unterminated_quote,
        crlf=crlf,
        trim=trim,
        skip_empty=skip_empty,
        drop=drop,
        take=take,
        transformers=transformers,
        decompress=decompress,
        prefer_compressed=prefer_compressed,
    )
