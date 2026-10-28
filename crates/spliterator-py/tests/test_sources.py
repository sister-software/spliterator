"""Sources and behaviour the byte-level conformance cases cannot reach: files on disk, the compressed-sibling lookup,
file objects, laziness and transformers."""

from __future__ import annotations

import asyncio
import gzip
import io
from pathlib import Path
from typing import Any

import pytest
import spliterator

LINES = "".join(f'{{"id":{i}}}\n' for i in range(5000))


def ids(rows: list[dict[str, int]]) -> list[int]:
    return [row["id"] for row in rows]


def test_gzip_path_and_sibling_lookup(tmp_path: Path) -> None:
    (tmp_path / "part.jsonl").write_text('{"id":-1}\n')
    (tmp_path / "part.jsonl.gz").write_bytes(gzip.compress(LINES.encode()))

    assert ids(list(spliterator.read_jsonl(tmp_path / "part.jsonl"))) == list(range(5000))
    assert ids(list(spliterator.read_jsonl(str(tmp_path / "part.jsonl"), prefer_compressed=False))) == [-1]


def test_a_compressed_path_reads_twice(tmp_path: Path) -> None:
    path = tmp_path / "data.jsonl.gz"
    path.write_bytes(gzip.compress(LINES.encode()))

    assert len(list(spliterator.read_text(path))) == 5000
    assert len(list(spliterator.read_text(path))) == 5000


def test_decompress_false_reads_the_bytes_as_given() -> None:
    with pytest.raises(spliterator.JSONRowError):
        list(spliterator.read_jsonl(gzip.compress(b'{"a":1}\n'), decompress=False))


def test_nothing_opens_until_the_first_pull(tmp_path: Path) -> None:
    rows = spliterator.read_text(tmp_path / "missing.txt")

    with pytest.raises(FileNotFoundError):
        next(rows)


def test_a_text_mode_file_is_refused() -> None:
    with pytest.raises(OSError, match="binary mode"):
        list(spliterator.read_text(io.StringIO("a\nb\n")))  # type: ignore[arg-type]


def test_large_input_spans_many_batches() -> None:
    data = "".join(f"{i},{'x' * (i % 50)}\n" for i in range(50_000)).encode()
    rows = list(spliterator.read_csv(data, header=False))

    assert len(rows) == 50_000
    assert rows[-1] == ["49999", "x" * (49_999 % 50)]


def test_rows_before_an_error_come_first() -> None:
    data = ("h\n" + "ok\n" * 10_000 + '"open\n').encode()
    rows: list[object] = []

    with pytest.raises(spliterator.UnterminatedQuoteError) as raised:
        for row in spliterator.read_csv(data):
            rows.append(row)  # noqa: PERF402 - the rows before the error are the point

    assert len(rows) == 10_000
    assert raised.value.byte_offset == 2 + 3 * 10_000


def test_transformers_bind_to_header_names() -> None:
    data = b"name,age\nAda,36\nBob\n"
    rows = list(
        spliterator.read_csv(data, transformers={"age": lambda value: int(value) if value else None, "zzz": str})
    )

    assert rows == [{"name": "Ada", "age": 36}, {"name": "Bob", "age": None}]

    entries = list(spliterator.read_csv(data, mode="entries", transformers={"age": len}))

    assert entries[0] == [("name", "Ada", 0), ("age", 2, 1)]

    arrays = list(spliterator.read_csv(data, mode="array", transformers={"age": int}))

    assert arrays == [["Ada", "36"], ["Bob"]]


def test_memoryview_and_bytearray_sources() -> None:
    assert list(spliterator.read_text(bytearray(b"a\nb"))) == ["a", "b"]
    assert list(spliterator.read_text(memoryview(b"a\nb"))) == ["a", "b"]


def test_large_integers_are_exact() -> None:
    # A documented difference from the TypeScript package, where JSON.parse rounds to a double.
    assert list(spliterator.read_jsonl(b"12345678901234567890")) == [12345678901234567890]


def test_bad_options_raise_value_error() -> None:
    with pytest.raises(ValueError, match="delimiter"):
        list(spliterator.read_text(b"a", delimiter=""))

    with pytest.raises(ValueError, match="mode"):
        list(spliterator.read_csv(b"a", mode="rows"))  # type: ignore[arg-type]


def test_unknown_options_raise_type_error() -> None:
    with pytest.raises(TypeError, match="normalise_keys"):
        list(spliterator.read_csv(b"a\n1", normalise_keys=True))  # type: ignore[call-arg]


def test_async_reader_over_a_compressed_path(tmp_path: Path) -> None:
    path = tmp_path / "data.jsonl.gz"
    path.write_bytes(gzip.compress(LINES.encode()))

    async def first_three() -> list[Any]:
        rows = []

        async for row in spliterator.aread_jsonl(path):
            rows.append(row)

            if len(rows) == 3:
                break

        return rows

    assert ids(asyncio.run(first_three())) == [0, 1, 2]


def test_async_csv_applies_transformers() -> None:
    async def collect() -> list[Any]:
        return [row async for row in spliterator.aread_csv(b"n\n1\n2\n", transformers={"n": int})]

    assert asyncio.run(collect()) == [{"n": 1}, {"n": 2}]


def test_counts_match_reads(tmp_path: Path) -> None:
    path = tmp_path / "part.jsonl.gz"
    path.write_bytes(gzip.compress(LINES.encode()))

    assert spliterator.count_text(path) == 5000
    assert spliterator.count_text(path, drop=10, take=7) == 7
    assert spliterator.count_csv(b"k,k\n1,2\n3,4\n") == 2
