//! WASM SIMD delimiter scanner for spliterator.
//!
//! Exports `find_delimiter` and `find_all_delimiters` using i8x16.eq +
//! i8x16.bitmask to accelerate delimiter scanning within WASM linear memory.
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

/// Find the first occurrence of `pattern` within `haystack` in WASM linear memory.
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

    let haystack_ptr = haystack_offset as *const u8;
    let pattern_ptr = pattern_offset as *const u8;

    if pattern_len == 1 {
        return find_single_byte(haystack_ptr, haystack_len, *pattern_ptr);
    }

    find_multi_byte(haystack_ptr, haystack_len, pattern_ptr, pattern_len)
}

/// Find all occurrences of `pattern` within `haystack` and write
/// `(start, end)` i32 pairs into the results buffer at `results_offset`.
///
/// Returns the number of ranges written (0 if none found).
///
/// Each range occupies 8 bytes (2 × i32). `max_results` caps the output.
/// The first range always starts at 0; the last range always ends at
/// `haystack_len` (the trailing segment after the final delimiter).
#[no_mangle]
pub unsafe extern "C" fn find_all_delimiters(
    haystack_offset: usize,
    haystack_len: usize,
    pattern_offset: usize,
    pattern_len: usize,
    results_offset: usize,
    max_results: usize,
) -> usize {
    if pattern_len == 0 || haystack_len == 0 || pattern_len > haystack_len || max_results == 0 {
        return 0;
    }

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
            // No more delimiters — emit the final range
            *results.add(count * 2) = range_start as i32;
            *results.add(count * 2 + 1) = haystack_len as i32;
            count += 1;
            break;
        }

        let delimiter_pos = search_start + pos as usize;

        // Emit the range [range_start, delimiter_pos)
        *results.add(count * 2) = range_start as i32;
        *results.add(count * 2 + 1) = delimiter_pos as i32;
        count += 1;

        // Advance past the delimiter
        search_start = delimiter_pos + pattern_len;
        range_start = search_start;
    }

    count
}

unsafe fn find_single_byte(haystack: *const u8, len: usize, needle: u8) -> i32 {
    let needle_splat = i8x16_splat(needle as i8);
    let mut offset = 0usize;

    while offset + 16 <= len {
        let chunk = v128_load(haystack.add(offset) as *const v128);
        let eq_mask = i8x16_eq(chunk, needle_splat);
        let bits = i8x16_bitmask(eq_mask) as u32;

        if bits != 0 {
            return (offset + bits.trailing_zeros() as usize) as i32;
        }

        offset += 16;
    }

    for i in offset..len {
        if *haystack.add(i) == needle {
            return i as i32;
        }
    }

    -1
}

unsafe fn find_multi_byte(
    haystack: *const u8,
    haystack_len: usize,
    pattern: *const u8,
    pat_len: usize,
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
                let mut matches = true;
                for j in 0..pat_len {
                    if *haystack.add(candidate + j) != *pattern.add(j) {
                        matches = false;
                        break;
                    }
                }
                if matches {
                    return candidate as i32;
                }
            }

            bits &= bits - 1;
        }

        offset += 16;
    }

    for i in offset..search_end {
        if *haystack.add(i) == *pattern {
            let mut matches = true;
            for j in 1..pat_len {
                if *haystack.add(i + j) != *pattern.add(j) {
                    matches = false;
                    break;
                }
            }
            if matches {
                return i as i32;
            }
        }
    }

    -1
}
