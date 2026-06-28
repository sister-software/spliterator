//! WASM SIMD delimiter scanner for spliterator.
//!
//! Exports `find_delimiter` using i8x16.eq + i8x16.bitmask to accelerate
//! multi-byte delimiter scanning within WASM linear memory.
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
///
/// Both haystack and pattern reside in WASM linear memory at the given offsets.
/// The JS host copies bytes into memory before calling this function.
///
/// Returns the byte offset of the first match relative to `haystack_offset`,
/// or -1 if not found.
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

    // Scalar tail
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

    // Scalar tail
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
