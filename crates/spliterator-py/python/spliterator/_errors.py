"""The errors every reader raises. They mirror the TypeScript package's error classes, so the same malformed input fails
the same way in every language."""

from __future__ import annotations


class SpliteratorError(Exception):
    """Base class for the errors a reader raises about its input."""


class UnterminatedQuoteError(SpliteratorError, ValueError):
    """Input ended inside a double-quoted region.

    A quote that never closes would otherwise swallow every later record, and the result would read like a smaller file.
    Records before the open quote have already been yielded. Pass ``allow_unterminated_quote=True`` to read it anyway.
    """

    byte_offset: int
    """Where the record holding the open quote starts, in bytes of the decompressed input."""

    def __init__(self, message: str, byte_offset: int) -> None:
        super().__init__(message)
        self.byte_offset = byte_offset


class DuplicateHeaderError(SpliteratorError, ValueError):
    """A header row named the same column twice while rows are keyed by name.

    Pass ``normalize_keys=True`` to suffix repeats, or read rows with ``mode="array"`` or ``mode="entries"``.
    """

    column: str
    """The repeated column name."""

    def __init__(self, message: str, column: str) -> None:
        super().__init__(message)
        self.column = column


class JSONRowError(SpliteratorError, ValueError):
    """A JSONL row failed to parse. The parser's error is the ``__cause__``."""

    row: int
    """The zero-based index of the row among those that reached the parser: after empty, blank and comment rows were
    skipped and after ``drop``."""

    def __init__(self, message: str, row: int) -> None:
        super().__init__(message)
        self.row = row
