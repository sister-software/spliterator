//! WASM SIMD delimiter scanner for spliterator.
//!
//! Exports:
//!   - find_delimiter: first match of a single pattern
//!   - find_all_delimiters: all matches of a single pattern → (start,end) pairs
//!   - find_all_matches: all matches of TWO patterns → (offset, pattern_id) pairs
//!
//! Build:
//!   RUSTFLAGS="-C target-feature=+simd128" cargo build --target wasm32-unknown-unknown --release
//!   wasm-opt -Oz target/wasm32-unknown-unknown/release/spliterator_wasm.wasm -o spliterator_wasm.wasm

#![no_std]

use core::arch::wasm32::*;
use core::panic::PanicInfo;

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// ── find_delimiter ────────────────────────────────────────────

#[no_mangle]
pub unsafe extern "C" fn find_delimiter(
    haystack_offset: usize,
    haystack_len: usize,
    pattern_offset: usize,
    pattern_len: usize,
) -> i32 {
    if pattern_len == 0 || haystack_len == 0 || pattern_len > haystack_len {
        return -1;
    }
    let h = haystack_offset as *const u8;
    let p = pattern_offset as *const u8;
    if pattern_len == 1 { return find_single_byte(h, haystack_len, *p); }
    find_multi_byte(h, haystack_len, p, pattern_len)
}

// ── find_all_delimiters ───────────────────────────────────────

#[no_mangle]
pub unsafe extern "C" fn find_all_delimiters(
    haystack_offset: usize,
    haystack_len: usize,
    pattern_offset: usize,
    pattern_len: usize,
    results_offset: usize,
    max_results: usize,
) -> usize {
    if pattern_len == 0 || haystack_len == 0 || max_results == 0 { return 0; }
    let haystack = haystack_offset as *const u8;
    let pattern = pattern_offset as *const u8;
    let results = results_offset as *mut i32;
    let mut count: usize = 0;
    let mut search_start: usize = 0;
    let mut range_start: usize = 0;

    while search_start + pattern_len <= haystack_len && count < max_results {
        let remaining = haystack_len - search_start;
        let pos = if pattern_len == 1 {
            find_single_byte(haystack.add(search_start), remaining, *pattern)
        } else {
            find_multi_byte(haystack.add(search_start), remaining, pattern, pattern_len)
        };
        if pos < 0 {
            *results.add(count * 2) = range_start as i32;
            *results.add(count * 2 + 1) = haystack_len as i32;
            count += 1;
            break;
        }
        let dp = search_start + pos as usize;
        *results.add(count * 2) = range_start as i32;
        *results.add(count * 2 + 1) = dp as i32;
        count += 1;
        search_start = dp + pattern_len;
        range_start = search_start;
    }
    count
}

// ── find_all_matches (two-pattern) ────────────────────────────

/// Scan for two patterns simultaneously, emitting (offset, pattern_id) pairs.
///
/// Patterns are stored consecutively in WASM memory at `pat1_offset`.
/// `pat1_len` and `pat2_len` are the byte lengths of each pattern.
/// Pattern 2 starts at `pat1_offset + pat1_len`.
///
/// Each result is two i32 values: [offset, pattern_id].
/// pattern_id is 0 for pattern 1 (delimiter), 1 for pattern 2 (quote).
/// Results are emitted in increasing offset order.
///
/// Returns the number of matches written.
#[no_mangle]
pub unsafe extern "C" fn find_all_matches(
    haystack_offset: usize,
    haystack_len: usize,
    pat1_offset: usize,
    pat1_len: usize,
    pat2_len: usize,
    results_offset: usize,
    max_results: usize,
) -> usize {
    if haystack_len == 0 || max_results == 0 { return 0; }
    if pat1_len == 0 && pat2_len == 0 { return 0; }

    let haystack = haystack_offset as *const u8;
    let pat1 = pat1_offset as *const u8;
    let pat2 = (pat1_offset as *const u8).add(pat1_len);
    let results = results_offset as *mut i32;

    // Fast path: both patterns are single-byte → SIMD double-scan
    if pat1_len == 1 && pat2_len == 1 {
        return find_all_matches_double_byte(
            haystack, haystack_len,
            *pat1, *pat2,
            results, max_results
        );
    }

    // General path: scan for both patterns independently, merge results
    let mut count: usize = 0;
    let mut offset: usize = 0;

    while offset < haystack_len && count < max_results {
        let remaining = haystack_len - offset;

        // Find next match of pattern 1
        let pos1 = if pat1_len == 1 {
            find_single_byte(haystack.add(offset), remaining, *pat1)
        } else if pat1_len > 1 {
            find_multi_byte(haystack.add(offset), remaining, pat1, pat1_len)
        } else {
            i32::MAX
        };

        // Find next match of pattern 2
        let pos2 = if pat2_len == 1 {
            find_single_byte(haystack.add(offset), remaining, *pat2)
        } else if pat2_len > 1 {
            find_multi_byte(haystack.add(offset), remaining, pat2, pat2_len)
        } else {
            i32::MAX
        };

        // Both absent → done
        if pos1 < 0 && pos2 < 0 { break; }

        // Pick the earlier match
        let (pos, pattern_id) = if pos1 >= 0 && (pos2 < 0 || pos1 <= pos2) {
            (pos1 as usize, 0i32)
        } else {
            (pos2 as usize, 1i32)
        };

        let abs_offset = offset + pos;
        *results.add(count * 2) = abs_offset as i32;
        *results.add(count * 2 + 1) = pattern_id;
        count += 1;

        // Advance past this match
        offset = abs_offset + if pattern_id == 0 { pat1_len } else { pat2_len };
    }

    count
}

/// SIMD double-scan: both patterns are single-byte.
/// Processes 16 bytes at a time with i8x16.eq for both patterns.
unsafe fn find_all_matches_double_byte(
    haystack: *const u8,
    len: usize,
    byte1: u8,
    byte2: u8,
    results: *mut i32,
    max_results: usize,
) -> usize {
    let splat1 = i8x16_splat(byte1 as i8);
    let splat2 = i8x16_splat(byte2 as i8);
    let mut count: usize = 0;
    let mut offset: usize = 0;

    while offset + 16 <= len && count < max_results {
        let chunk = v128_load(haystack.add(offset) as *const v128);

        let mask1 = i8x16_bitmask(i8x16_eq(chunk, splat1)) as u32;
        let mask2 = i8x16_bitmask(i8x16_eq(chunk, splat2)) as u32;

        // Emit matches in position order within this chunk
        let mut remaining = (mask1 | mask2) as u32;
        while remaining != 0 && count < max_results {
            let pos = remaining.trailing_zeros() as usize;
            let abs = offset + pos;

            let is_pat1 = (mask1 >> pos) & 1 != 0;
            let pattern_id: i32 = if is_pat1 { 0 } else { 1 };

            *results.add(count * 2) = abs as i32;
            *results.add(count * 2 + 1) = pattern_id;
            count += 1;

            // Clear this bit
            remaining &= remaining - 1;
        }

        offset += 16;
    }

    // Scalar tail
    while offset < len && count < max_results {
        let b = *haystack.add(offset);
        if b == byte1 {
            *results.add(count * 2) = offset as i32;
            *results.add(count * 2 + 1) = 0;
            count += 1;
        } else if b == byte2 {
            *results.add(count * 2) = offset as i32;
            *results.add(count * 2 + 1) = 1;
            count += 1;
        }
        offset += 1;
    }

    count
}

// ── Single-byte scan ──────────────────────────────────────────

unsafe fn find_single_byte(haystack: *const u8, len: usize, needle: u8) -> i32 {
    let needle_splat = i8x16_splat(needle as i8);
    let mut offset = 0usize;
    while offset + 16 <= len {
        let chunk = v128_load(haystack.add(offset) as *const v128);
        let eq_mask = i8x16_eq(chunk, needle_splat);
        let bits = i8x16_bitmask(eq_mask) as u32;
        if bits != 0 { return (offset + bits.trailing_zeros() as usize) as i32; }
        offset += 16;
    }
    for i in offset..len {
        if *haystack.add(i) == needle { return i as i32; }
    }
    -1
}

// ── Multi-byte scan ───────────────────────────────────────────

unsafe fn find_multi_byte(
    haystack: *const u8, haystack_len: usize,
    pattern: *const u8, pat_len: usize,
) -> i32 {
    let first_byte = i8x16_splat(*pattern as i8);
    let search_end = haystack_len.saturating_sub(pat_len - 1);
    let mut offset = 0usize;
    while offset + 16 <= search_end {
        let chunk = v128_load(haystack.add(offset) as *const v128);
        let eq_mask = i8x16_eq(chunk, first_byte);
        let mut bits = i8x16_bitmask(eq_mask) as u32;
        while bits != 0 {
            let pos = bits.trailing_zeros() as usize;
            let candidate = offset + pos;
            if candidate + pat_len <= haystack_len {
                let mut ok = true;
                for j in 0..pat_len {
                    if *haystack.add(candidate + j) != *pattern.add(j) { ok = false; break; }
                }
                if ok { return candidate as i32; }
            }
            bits &= bits - 1;
        }
        offset += 16;
    }
    for i in offset..search_end {
        if *haystack.add(i) == *pattern {
            let mut ok = true;
            for j in 1..pat_len {
                if *haystack.add(i + j) != *pattern.add(j) { ok = false; break; }
            }
            if ok { return i as i32; }
        }
    }
    -1
}
