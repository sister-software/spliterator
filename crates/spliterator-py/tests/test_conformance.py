"""The Python runner for the language-neutral conformance suite in ``conformance/``.

Every case runs over bytes, over a ``BytesIO`` and over a temporary file, so the path, in-memory and file-object
sources, and decompression on each, all answer to the same expectations as the TypeScript and Rust runners.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
from collections.abc import AsyncIterator, Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
import spliterator

CONFORMANCE = Path(__file__).resolve().parents[3] / "conformance"
FILES = ["text", "jsonl", "csv", "compression"]

READERS: dict[str, Callable[..., Iterator[Any]]] = {
    "text": spliterator.read_text,
    "jsonl": spliterator.read_jsonl,
    "csv": spliterator.read_csv,
    "tsv": spliterator.read_tsv,
    "psv": spliterator.read_psv,
}

# The suite names options as the TypeScript package does; this binding takes them in snake_case.
OPTION_NAMES = {
    "delimiter": "delimiter",
    "trim": "trim",
    "skipEmpty": "skip_empty",
    "crlf": "crlf",
    "drop": "drop",
    "take": "take",
    "enableQuoteHandling": "enable_quote_handling",
    "allowUnterminatedQuote": "allow_unterminated_quote",
    "comment": "comment",
    "header": "header",
    "mode": "mode",
    "normalizeKeys": "normalize_keys",
    "columnDelimiter": "column_delimiter",
}

ASYNC_READERS: dict[str, Callable[..., AsyncIterator[Any]]] = {
    "text": spliterator.aread_text,
    "jsonl": spliterator.aread_jsonl,
    "csv": spliterator.aread_csv,
    "tsv": spliterator.aread_tsv,
    "psv": spliterator.aread_psv,
}

COUNTERS: dict[str, Callable[..., int]] = {
    "text": spliterator.count_text,
    "csv": spliterator.count_csv,
    "tsv": spliterator.count_tsv,
    "psv": spliterator.count_psv,
}

ERRORS = {
    "UnterminatedQuote": (spliterator.UnterminatedQuoteError, "byteOffset", "byte_offset"),
    "DuplicateHeader": (spliterator.DuplicateHeaderError, "column", "column"),
    "JSONRow": (spliterator.JSONRowError, "row", "row"),
}


def load_cases() -> list[Any]:
    params: list[Any] = []

    for name in FILES:
        data = json.loads((CONFORMANCE / f"{name}.json").read_text(encoding="utf-8"))

        for case in data["cases"]:
            fmt = case.get("format", data["format"])

            params.extend(
                pytest.param(fmt, case, source, id=f"{name}.json :: {case['name']} :: {source}")
                for source in ("bytes", "file object", "path", "async", "count")
            )

    return params


def input_bytes(value: str | dict[str, str]) -> bytes:
    return value.encode("utf-8") if isinstance(value, str) else base64.b64decode(value["base64"])


def plain(value: Any) -> Any:
    """Entries rows are tuples here and arrays in JSON."""
    if isinstance(value, (list, tuple)):
        return [plain(item) for item in value]

    if isinstance(value, dict):
        return {key: plain(item) for key, item in value.items()}

    return value


@pytest.mark.parametrize(("fmt", "case", "source_kind"), load_cases())
def test_conformance(fmt: str, case: dict[str, Any], source_kind: str, tmp_path: Path) -> None:
    data = input_bytes(case["input"])
    options = {OPTION_NAMES[key]: value for key, value in case.get("options", {}).items()}

    if source_kind == "bytes":
        source: Any = data
    elif source_kind == "file object":
        source = io.BytesIO(data)
    else:
        source = tmp_path / "input"
        source.write_bytes(data)

    if source_kind == "count":
        check_count(fmt, case, data, options)

        return

    if source_kind == "async":
        check_async(fmt, case, data, options)

        return

    rows: list[Any] = []
    reader = READERS[fmt](source, **options)

    if "error" in case:
        expected = case["error"]
        error_type, json_field, attribute = ERRORS[expected["type"]]

        with pytest.raises(error_type) as raised:
            for row in reader:
                rows.append(plain(row))  # noqa: PERF401 - the rows before the error are the point

        assert getattr(raised.value, attribute) == expected[json_field]

        if "expectBeforeError" in case:
            assert rows == case["expectBeforeError"]

        return

    rows = [plain(row) for row in reader]

    assert rows == case["expect"]


def check_count(fmt: str, case: dict[str, Any], data: bytes, options: dict[str, Any]) -> None:
    """A count must equal the number of rows the reader yields. It reads no header names, so a repeated header is not
    its error to raise."""
    if fmt not in COUNTERS or case.get("error", {}).get("type") == "DuplicateHeader":
        pytest.skip("no count for this case")

    if "error" in case:
        expected = case["error"]
        error_type, json_field, attribute = ERRORS[expected["type"]]

        with pytest.raises(error_type) as raised:
            COUNTERS[fmt](data, **options)

        assert getattr(raised.value, attribute) == expected[json_field]

        return

    assert COUNTERS[fmt](data, **options) == len(case["expect"])


def check_async(fmt: str, case: dict[str, Any], data: bytes, options: dict[str, Any]) -> None:
    rows: list[Any] = []

    async def collect() -> None:
        async for row in ASYNC_READERS[fmt](data, **options):
            rows.append(plain(row))  # noqa: PERF401 - the rows before an error are the point

    if "error" in case:
        expected = case["error"]
        error_type, json_field, attribute = ERRORS[expected["type"]]

        with pytest.raises(error_type) as raised:
            asyncio.run(collect())

        assert getattr(raised.value, attribute) == expected[json_field]

        if "expectBeforeError" in case:
            assert rows == case["expectBeforeError"]

        return

    asyncio.run(collect())

    assert rows == case["expect"]
