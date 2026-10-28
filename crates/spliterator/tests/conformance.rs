//! The Rust runner for the language-neutral conformance suite in `conformance/`. Every case runs over bytes in memory
//! and over readers that hand out 1, 3 and 64 bytes per call, all through `open`, so decompression is exercised too.

use std::io::Read;
use std::path::PathBuf;

use base64::Engine;
use serde_json::{json, Map, Value};
use spliterator::{csv, jsonl, open, text, Error, OpenOptions, Source};

const FILES: [&str; 4] = ["text", "jsonl", "csv", "compression"];

/// A reader that returns at most `size` bytes per call, to put chunk boundaries everywhere.
struct Trickle {
    bytes: Vec<u8>,
    position: usize,
    size: usize,
}

impl Read for Trickle {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let end = (self.position + self.size.min(buffer.len())).min(self.bytes.len());
        let length = end - self.position;

        buffer[..length].copy_from_slice(&self.bytes[self.position..end]);
        self.position = end;

        Ok(length)
    }
}

fn conformance_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../conformance")
}

fn input_bytes(input: &Value) -> Vec<u8> {
    match input {
        Value::String(text) => text.as_bytes().to_vec(),
        Value::Object(object) => base64::engine::general_purpose::STANDARD
            .decode(object["base64"].as_str().expect("base64 input"))
            .expect("valid base64"),
        other => panic!("unexpected input {other}"),
    }
}

fn sources(bytes: &[u8]) -> Vec<(String, Box<dyn Fn() -> Source>)> {
    let mut sources: Vec<(String, Box<dyn Fn() -> Source>)> = Vec::new();
    let whole = bytes.to_vec();

    sources.push((
        "bytes".into(),
        Box::new(move || Source::Bytes(whole.clone())),
    ));

    for size in [1, 3, 64] {
        let owned = bytes.to_vec();

        sources.push((
            format!("reader, {size} bytes per read"),
            Box::new(move || {
                Source::Reader(Box::new(Trickle {
                    bytes: owned.clone(),
                    position: 0,
                    size,
                }))
            }),
        ));
    }

    sources
}

fn string(value: &Value) -> String {
    value.as_str().expect("a string option").to_owned()
}

fn count(value: &Value) -> usize {
    value.as_u64().expect("a count option") as usize
}

fn text_options(options: &Map<String, Value>) -> text::Options {
    let mut result = text::Options::default();

    for (key, value) in options {
        match key.as_str() {
            "delimiter" => result.delimiter = string(value).into_bytes(),
            "trim" => result.trim = value.as_bool().unwrap(),
            "skipEmpty" => result.skip_empty = value.as_bool().unwrap(),
            "crlf" => result.crlf = value.as_bool().unwrap(),
            "drop" => result.drop = count(value),
            "take" => result.take = Some(count(value)),
            "enableQuoteHandling" => result.enable_quote_handling = value.as_bool().unwrap(),
            "allowUnterminatedQuote" => result.allow_unterminated_quote = value.as_bool().unwrap(),
            other => panic!("text option {other} is not mapped"),
        }
    }

    result
}

fn jsonl_options(options: &Map<String, Value>) -> jsonl::Options {
    let mut result = jsonl::Options::default();

    for (key, value) in options {
        match key.as_str() {
            "delimiter" => result.delimiter = string(value).into_bytes(),
            "skipEmpty" => result.skip_empty = value.as_bool().unwrap(),
            "crlf" => result.crlf = value.as_bool().unwrap(),
            "drop" => result.drop = count(value),
            "take" => result.take = Some(count(value)),
            "comment" => {
                result.comment = Some(match value {
                    Value::String(prefix) => vec![prefix.clone()],
                    Value::Array(prefixes) => prefixes.iter().map(string).collect(),
                    other => panic!("unexpected comment {other}"),
                })
            }
            other => panic!("jsonl option {other} is not mapped"),
        }
    }

    result
}

fn csv_options(format: &str, options: &Map<String, Value>) -> csv::Options {
    let mut result = match format {
        "tsv" => csv::Options::tsv(),
        "psv" => csv::Options::psv(),
        _ => csv::Options::csv(),
    };

    for (key, value) in options {
        match key.as_str() {
            "delimiter" => result.row_delimiter = string(value).into_bytes(),
            "columnDelimiter" => result.column_delimiter = string(value).into_bytes(),
            "header" => result.header = value.as_bool().unwrap(),
            "normalizeKeys" => result.normalize_keys = value.as_bool().unwrap(),
            "mode" => {
                result.mode = Some(match value.as_str().unwrap() {
                    "object" => csv::Mode::Object,
                    "array" => csv::Mode::Array,
                    "entries" => csv::Mode::Entries,
                    other => panic!("unknown mode {other}"),
                })
            }
            "trim" => result.trim = value.as_bool().unwrap(),
            "skipEmpty" => result.skip_empty = value.as_bool().unwrap(),
            "crlf" => result.crlf = value.as_bool().unwrap(),
            "drop" => result.drop = count(value),
            "take" => result.take = Some(count(value)),
            "enableQuoteHandling" => result.enable_quote_handling = value.as_bool().unwrap(),
            "allowUnterminatedQuote" => result.allow_unterminated_quote = value.as_bool().unwrap(),
            other => panic!("csv option {other} is not mapped"),
        }
    }

    result
}

fn csv_row(row: csv::Row, mode: csv::Mode) -> Value {
    match mode {
        csv::Mode::Array => json!(row.cells),
        csv::Mode::Object => Value::Object(
            row.to_pairs()
                .into_iter()
                .map(|(key, value)| (key, json!(value)))
                .collect(),
        ),
        csv::Mode::Entries => json!(row
            .to_entries()
            .into_iter()
            .map(|(k, v, i)| json!([k, v, i]))
            .collect::<Vec<_>>()),
    }
}

/// Run a case and collect its rows until the end or the first error.
fn run(format: &str, options: &Map<String, Value>, source: Source) -> (Vec<Value>, Option<Error>) {
    let reader = match open(source, OpenOptions::default()) {
        Ok(reader) => reader,
        Err(error) => return (Vec::new(), Some(error)),
    };

    let mut rows = Vec::new();

    let mut push = |row: Result<Value, Error>| -> Option<Error> {
        match row {
            Ok(value) => {
                rows.push(value);

                None
            }
            Err(error) => Some(error),
        }
    };

    let error = match format {
        "text" => text::Reader::new(reader, text_options(options))
            .map(|r| r.map(|row| row.map(Value::String)).find_map(&mut push)),
        "jsonl" => {
            jsonl::Reader::new(reader, jsonl_options(options)).map(|mut r| r.find_map(&mut push))
        }
        _ => {
            let options = csv_options(format, options);
            let mode = options.resolved_mode();

            csv::Reader::new(reader, options).map(|r| {
                r.map(|row| row.map(|row| csv_row(row, mode)))
                    .find_map(&mut push)
            })
        }
    };

    let error = match error {
        Ok(error) => error,
        Err(error) => Some(error),
    };

    (rows, error)
}

/// JSON equality with numbers compared by value, so `-2500` from the fixture equals serde's `-2500.0`.
fn same(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same(x, y))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| same(value, other)))
        }
        _ => left == right,
    }
}

fn error_matches(error: &Error, expected: &Value) -> bool {
    match (expected["type"].as_str().unwrap(), error) {
        ("UnterminatedQuote", Error::UnterminatedQuote { byte_offset }) => {
            expected["byteOffset"].as_u64() == Some(*byte_offset)
        }
        ("DuplicateHeader", Error::DuplicateHeader { column }) => {
            expected["column"].as_str() == Some(column.as_str())
        }
        ("JSONRow", Error::JsonRow { row, .. }) => expected["row"].as_u64() == Some(*row as u64),
        _ => false,
    }
}

#[test]
fn conformance() {
    let mut failures = Vec::new();
    let mut checked = 0;

    for name in FILES {
        let file: Value = serde_json::from_str(
            &std::fs::read_to_string(conformance_dir().join(format!("{name}.json"))).unwrap(),
        )
        .unwrap();
        let default_format = file["format"].as_str().unwrap();

        for case in file["cases"].as_array().unwrap() {
            let format = case
                .get("format")
                .and_then(Value::as_str)
                .unwrap_or(default_format);
            let options = case
                .get("options")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let bytes = input_bytes(&case["input"]);

            for (label, source) in sources(&bytes) {
                checked += 1;

                let (rows, error) = run(format, &options, source());
                let id = format!("{name}.json › {} › {label}", case["name"].as_str().unwrap());

                if let Some(expected) = case.get("error") {
                    match &error {
                        Some(error) if error_matches(error, expected) => {}
                        other => {
                            failures.push(format!("{id}: expected error {expected}, got {other:?}"))
                        }
                    }

                    if let Some(before) = case.get("expectBeforeError") {
                        if !same(&Value::Array(rows), before) {
                            failures.push(format!("{id}: rows before the error differ"));
                        }
                    }

                    continue;
                }

                if let Some(error) = error {
                    failures.push(format!("{id}: unexpected error {error}"));

                    continue;
                }

                let actual = Value::Array(rows);

                if !same(&actual, &case["expect"]) {
                    failures.push(format!(
                        "{id}:\n  expected {}\n  actual   {actual}",
                        case["expect"]
                    ));
                }
            }
        }
    }

    assert!(
        failures.is_empty(),
        "{} of {checked} conformance checks failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
