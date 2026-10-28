"""Types shared by the public module and the native stubs."""

from __future__ import annotations

from typing import Protocol


class SupportsRead(Protocol):
    """A binary stream: anything with ``read(size) -> bytes``.

    Structural rather than ``BinaryIO``, so the objects the standard library hands out type-check as they are: an
    ``open(path, "rb")`` handle, ``io.BytesIO``, a ``zipfile.ZipFile.open`` member, ``gzip.open``, a socket's
    ``makefile("rb")``.
    """

    def read(self, size: int = ..., /) -> bytes: ...
