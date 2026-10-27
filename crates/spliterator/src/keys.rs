//! Header normalization: the TypeScript package's `normalizeColumnNames`, rule for rule.
//!
//! Names are snake_cased unless already all caps, lowercased, and repeats suffixed `_2`, `_3`, …. Two details are easy
//! to get wrong in a port: ECMAScript's `\d` is ASCII-only even in Unicode mode, so the patterns spell out `0-9`; and
//! `trim` uses the ECMAScript whitespace set.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;

use crate::whitespace::trim;

struct Patterns {
    periods_after_capitals: Regex,
    non_key: Regex,
    repeated_underscores: Regex,
    lower_upper: Regex,
    upper_upper: Regex,
    non_word: Regex,
}

fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();

    PATTERNS.get_or_init(|| Patterns {
        periods_after_capitals: Regex::new(r"([A-Z])\.+").unwrap(),
        non_key: Regex::new(r"[^\p{L}\p{N}_]+").unwrap(),
        repeated_underscores: Regex::new(r"_{2,}").unwrap(),
        lower_upper: Regex::new(r"([\p{Ll}0-9])(\p{Lu})").unwrap(),
        upper_upper: Regex::new(r"(\p{Lu})(\p{Lu}\p{Ll})").unwrap(),
        non_word: Regex::new(r"(?i)[^\p{L}0-9]+").unwrap(),
    })
}

/// The words of a name: split on lower→upper and acronym→word boundaries and on anything that is not a letter or an
/// ASCII digit.
fn split_words(input: &str) -> Vec<String> {
    let p = patterns();
    let mut result = p
        .lower_upper
        .replace_all(trim(input), "${1}\0${2}")
        .into_owned();

    result = p
        .upper_upper
        .replace_all(&result, "${1}\0${2}")
        .into_owned();
    result = p.non_word.replace_all(&result, "\0").into_owned();

    let trimmed = result.trim_matches('\0');

    if trimmed.is_empty() {
        return Vec::new();
    }

    trimmed.split('\0').map(str::to_owned).collect()
}

/// `name` in snake_case.
pub fn snake_case(name: &str) -> String {
    split_words(name)
        .iter()
        .map(|word| word.to_lowercase())
        .collect::<Vec<_>>()
        .join("_")
}

/// `name` in snake_case, unless it is already all caps (caseless scripts count), in which case anything that cannot be
/// part of a key becomes one underscore.
pub fn smart_snake_case(name: &str) -> String {
    let p = patterns();
    let without_periods = p.periods_after_capitals.replace_all(name, "${1}");
    let normalized = trim(&without_periods);

    if normalized.to_uppercase() == normalized {
        let keyed = p.non_key.replace_all(normalized, "_");

        return p.repeated_underscores.replace_all(&keyed, "_").into_owned();
    }

    snake_case(normalized)
}

/// Normalize a header row into unique, lowercase snake_case keys. A suffixed name that collides with a literal header
/// keeps counting, so every header gets exactly one key.
pub fn normalize_column_names<S: AsRef<str>>(headers: &[S]) -> Vec<String> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut names = Vec::with_capacity(headers.len());

    for header in headers {
        let name = smart_snake_case(header.as_ref()).to_lowercase();

        if seen.insert(name.clone()) {
            names.push(name);

            continue;
        }

        let mut count = counts.get(&name).copied().unwrap_or(1);
        let unique = loop {
            count += 1;
            let candidate = format!("{name}_{count}");

            if !seen.contains(&candidate) {
                break candidate;
            }
        };

        counts.insert(name, count);
        seen.insert(unique.clone());
        names.push(unique);
    }

    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_typescript_rules() {
        assert_eq!(
            normalize_column_names(&["First Name", "LAST NAME", "first name"]),
            ["first_name", "last_name", "first_name_2"]
        );
        assert_eq!(
            normalize_column_names(&["itemName", "XMLHttpRequest", "Some-Thing", "U.S.A. Code"]),
            ["item_name", "xml_http_request", "some_thing", "usa_code"]
        );
        assert_eq!(
            normalize_column_names(&["영업상태명", "주소 (도로명)"]),
            ["영업상태명", "주소_도로명_"]
        );
        assert_eq!(
            normalize_column_names(&["a_2", "a", "a"]),
            ["a_2", "a", "a_3"]
        );
        assert_eq!(smart_snake_case("LON"), "LON");
    }
}
