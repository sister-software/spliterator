from collections.abc import Iterator
from typing import Any, BinaryIO, TypeAlias

_Source: TypeAlias = str | bytes | BinaryIO

class TextBatches(Iterator[list[str]]):
    def __init__(
        self,
        source: _Source,
        delimiter: bytes,
        trim: bool,
        skip_empty: bool,
        crlf: bool,
        drop: int,
        take: int | None,
        enable_quote_handling: bool,
        allow_unterminated_quote: bool,
        decompress: bool,
        prefer_compressed: bool,
    ) -> None: ...
    def __next__(self) -> list[str]: ...

class JsonlRows(Iterator[list[str]]):
    def __init__(
        self,
        source: _Source,
        delimiter: bytes,
        skip_empty: bool,
        crlf: bool,
        comment: list[str] | None,
        drop: int,
        take: int | None,
        decompress: bool,
        prefer_compressed: bool,
    ) -> None: ...
    def __next__(self) -> list[str]: ...

class CsvBatches(Iterator[list[Any]]):
    def __init__(
        self,
        source: _Source,
        row_delimiter: bytes,
        column_delimiter: bytes,
        enable_quote_handling: bool,
        allow_unterminated_quote: bool,
        crlf: bool,
        trim: bool,
        skip_empty: bool,
        header: bool,
        mode: str | None,
        normalize_keys: bool,
        drop: int,
        take: int | None,
        decompress: bool,
        prefer_compressed: bool,
    ) -> None: ...
    @property
    def headers(self) -> list[str] | None: ...
    def __next__(self) -> list[Any]: ...

def count_text(
    source: _Source,
    delimiter: bytes,
    trim: bool,
    skip_empty: bool,
    crlf: bool,
    drop: int,
    take: int | None,
    enable_quote_handling: bool,
    allow_unterminated_quote: bool,
    decompress: bool,
    prefer_compressed: bool,
) -> int: ...
def count_csv(
    source: _Source,
    row_delimiter: bytes,
    column_delimiter: bytes,
    enable_quote_handling: bool,
    allow_unterminated_quote: bool,
    crlf: bool,
    skip_empty: bool,
    header: bool,
    drop: int,
    take: int | None,
    decompress: bool,
    prefer_compressed: bool,
) -> int: ...
