//! The whitespace `trim` removes: ECMAScript's `WhiteSpace` and `LineTerminator` sets, which is what
//! `String.prototype.trim` strips in the TypeScript package.
//!
//! Neither Rust's `char::is_whitespace` nor Python's `str.strip` uses this set. Both strip U+0085 (NEL), which
//! ECMAScript keeps, and neither strips U+FEFF, which ECMAScript removes. Parity needs the set spelled out.

/// Whether `c` is whitespace to ECMAScript's `trim`.
pub fn is_trim_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// `text` without leading and trailing ECMAScript whitespace.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_trim_whitespace)
}

/// Whether `text` is empty once trimmed.
pub fn is_blank(text: &str) -> bool {
    text.chars().all(is_trim_whitespace)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_ecmascript_not_rust_or_python() {
        assert_eq!(trim("\u{00A0}a\u{3000}"), "a");
        assert_eq!(trim("\u{FEFF}a\u{2028}"), "a");
        assert_eq!(trim("\u{0085}a\u{0085}"), "\u{0085}a\u{0085}");
        assert_eq!(trim("\u{001C}a\u{001F}"), "\u{001C}a\u{001F}");
        assert!(is_blank(" \t\u{3000}"));
        assert!(!is_blank("\u{0085}"));
    }
}
