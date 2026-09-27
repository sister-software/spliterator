//! WASM SIMD delimiter scanner for spliterator.
//!
//! Exports:
//!   - find_delimiter: first match of a single pattern
//!   - find_all_delimiters: all matches of a single pattern → (start,end) pairs
//!   - find_all_matches: all matches of TWO patterns → (offset, pattern_id) pairs
//!   - scan_delimited_ranges: resumable single-byte delimiter/quote scan → ranges + state
//!   - scan_csv_cells: resumable CSV cell scan with UTF-16 unit counting → cells + state
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
    if pattern_len == 1 {
        return find_single_byte(h, haystack_len, *p);
    }
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
    if pattern_len == 0 || haystack_len == 0 || max_results == 0 {
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
            break;
        }
        let dp = search_start + pos as usize;
        *results.add(count * 2) = range_start as i32;
        *results.add(count * 2 + 1) = dp as i32;
        count += 1;
        search_start = dp + pattern_len;
        range_start = search_start;
    }
    // Trailing field after the last delimiter. The JS scanner always emits
    // [range_start, haystack_len] here, which is an empty range when the haystack ends
    // exactly on a delimiter — without this the final (empty) field would be dropped.
    if count < max_results {
        *results.add(count * 2) = range_start as i32;
        *results.add(count * 2 + 1) = haystack_len as i32;
        count += 1;
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
    if haystack_len == 0 || max_results == 0 {
        return 0;
    }
    if pat1_len == 0 && pat2_len == 0 {
        return 0;
    }

    let haystack = haystack_offset as *const u8;
    let pat1 = pat1_offset as *const u8;
    let pat2 = (pat1_offset as *const u8).add(pat1_len);
    let results = results_offset as *mut i32;

    // Fast path: both patterns are single-byte → SIMD double-scan
    if pat1_len == 1 && pat2_len == 1 {
        return find_all_matches_double_byte(
            haystack,
            haystack_len,
            *pat1,
            *pat2,
            results,
            max_results,
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
        if pos1 < 0 && pos2 < 0 {
            break;
        }

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

// ── scan_delimited_ranges (stateful, bounded) ─────────────────────────

/// Scan a byte window for a single-byte delimiter, optionally ignoring delimiters
/// inside double-quoted regions. Unlike `find_all_matches`, this primitive emits
/// completed ranges directly and can stop at a caller-provided capacity without
/// losing its place.
///
/// `quote` is -1 when quote handling is disabled, otherwise it is the quote byte.
/// The first three i32 values at `results_offset` receive updated state:
/// `[scan_cursor, pending_slice_start, inside_quotes]`. Range pairs follow.
///
/// When the output fills, the delimiter that would produce the next range is left
/// unconsumed. Passing the returned state to the next call resumes exactly there.
#[no_mangle]
pub unsafe extern "C" fn scan_delimited_ranges(
    haystack_offset: usize,
    haystack_len: usize,
    scan_start: usize,
    pending_slice_start: usize,
    delimiter: u32,
    quote: i32,
    inside_quotes: i32,
    results_offset: usize,
    max_ranges: usize,
) -> usize {
    let results = results_offset as *mut i32;
    let mut cursor = scan_start.min(haystack_len);
    let mut slice_start = pending_slice_start.min(haystack_len);
    let mut quoted = inside_quotes != 0;
    let mut count = 0usize;
    let delimiter_byte = delimiter as u8;
    let quote_byte = quote as u8;
    let quote_enabled = quote >= 0;
    let haystack = haystack_offset as *const u8;
    let delimiter_splat = i8x16_splat(delimiter_byte as i8);
    let quote_splat = i8x16_splat(quote_byte as i8);

    while cursor + 16 <= haystack_len {
        let chunk = v128_load(haystack.add(cursor) as *const v128);
        let delimiter_mask = i8x16_bitmask(i8x16_eq(chunk, delimiter_splat)) as u32;
        let quote_mask = if quote_enabled {
            i8x16_bitmask(i8x16_eq(chunk, quote_splat)) as u32
        } else {
            0
        };
        let mut matches = delimiter_mask | quote_mask;

        while matches != 0 {
            let position = matches.trailing_zeros() as usize;
            let offset = cursor + position;
            // Pattern 1 (the delimiter) wins when both configured bytes are equal,
            // matching `find_all_matches` and the JavaScript merge fallback.
            let is_delimiter = (delimiter_mask >> position) & 1 != 0;
            let is_quote = quote_enabled && !is_delimiter && ((quote_mask >> position) & 1 != 0);

            if is_quote {
                quoted = !quoted;
            } else if !quoted {
                if count >= max_ranges {
                    write_range_scan_state(results, offset, slice_start, quoted);
                    return count;
                }

                *results.add(3 + count * 2) = slice_start as i32;
                *results.add(4 + count * 2) = offset as i32;
                count += 1;
                slice_start = offset + 1;
            }

            matches &= matches - 1;
        }

        cursor += 16;
    }

    while cursor < haystack_len {
        let byte = *haystack.add(cursor);

        if byte == delimiter_byte {
            if !quoted {
                if count >= max_ranges {
                    write_range_scan_state(results, cursor, slice_start, quoted);
                    return count;
                }

                *results.add(3 + count * 2) = slice_start as i32;
                *results.add(4 + count * 2) = cursor as i32;
                count += 1;
                slice_start = cursor + 1;
            }
        } else if quote_enabled && byte == quote_byte {
            quoted = !quoted;
        }

        cursor += 1;
    }

    write_range_scan_state(results, haystack_len, slice_start, quoted);
    count
}

#[inline]
unsafe fn write_range_scan_state(
    results: *mut i32,
    cursor: usize,
    slice_start: usize,
    inside_quotes: bool,
) {
    *results = cursor as i32;
    *results.add(1) = slice_start as i32;
    *results.add(2) = if inside_quotes { 1 } else { 0 };
}

// ── scan_csv_cells ────────────────────────────────────────────

const CELL_RESULT_HEADER: usize = 5;
const CELL_RESULT_STRIDE: usize = 3;
const CELL_FLAG_ROW_END: i32 = 1;
const CELL_FLAG_HAS_QUOTE: i32 = 2;

/// Resumable single-pass CSV cell scan. Emits `[start, end, flags]` per cell in UTF-16 code
/// units relative to the window's unit base, tracking quote state and counting units from the
/// UTF-8 lead-byte pattern. See docs/superpowers/specs/2026-09-27-csv-bulk-cell-scan-design.md.
///
/// Results block (i32): [cursor, units, inside_quotes, cell_start_units, cell_has_quote, cells...]
#[no_mangle]
pub unsafe extern "C" fn scan_csv_cells(
    haystack_offset: usize,
    haystack_len: usize,
    row_delimiter: u32,
    column_delimiter: u32,
    quote: i32,
    crlf: i32,
    inside_quotes: i32,
    cell_start_units: i32,
    cell_has_quote: i32,
    previous_byte: i32,
    results_offset: usize,
    max_cells: usize,
) -> usize {
    let results = results_offset as *mut i32;
    let haystack = haystack_offset as *const u8;
    let row_byte = row_delimiter as u8;
    let col_byte = column_delimiter as u8;
    let quote_enabled = quote >= 0;
    let quote_byte = quote as u8;
    let crlf = crlf != 0;

    let mut cursor = 0usize;
    let mut units: i32 = 0;
    let mut quoted = inside_quotes != 0;
    let mut cell_start = cell_start_units;
    let mut has_quote = cell_has_quote != 0;
    let mut count = 0usize;

    let row_splat = i8x16_splat(row_byte as i8);
    let col_splat = i8x16_splat(col_byte as i8);
    let quote_splat = i8x16_splat(quote_byte as i8);
    let cont_mask_splat = u8x16_splat(0xC0);
    let cont_value_splat = u8x16_splat(0x80);
    let four_splat = u8x16_splat(0xF0);

    // Units contributed by a byte at `offset`: 1 unless it is a continuation byte, plus 1 more
    // for a 4-byte lead. The scalar tail and the in-vector prefix both use this.
    #[inline(always)]
    fn byte_units(b: u8) -> i32 {
        if b & 0xC0 == 0x80 {
            0
        } else if b >= 0xF0 {
            2
        } else {
            1
        }
    }

    // Closes the open cell at byte `offset`, whose unit offset is `units_at`. Returns false when
    // the result block is full (the caller then writes state and returns without consuming).
    #[inline(always)]
    unsafe fn close_cell(
        results: *mut i32,
        count: &mut usize,
        max_cells: usize,
        cell_start: &mut i32,
        has_quote: &mut bool,
        units_at: i32,
        end_units: i32,
        row_end: bool,
    ) -> bool {
        if *count >= max_cells {
            return false;
        }

        let base = CELL_RESULT_HEADER + *count * CELL_RESULT_STRIDE;
        let mut flags = 0;

        if row_end {
            flags |= CELL_FLAG_ROW_END;
        }

        if *has_quote {
            flags |= CELL_FLAG_HAS_QUOTE;
        }

        *results.add(base) = *cell_start;
        *results.add(base + 1) = end_units;
        *results.add(base + 2) = flags;
        *count += 1;
        // The delimiter is one ASCII byte, one unit.
        *cell_start = units_at + 1;
        *has_quote = false;

        true
    }

    // Returns the unit offset at which the cell ends for a row delimiter at `offset`:
    // one unit short when crlf is on and the byte before is CR, and that CR is inside the cell.
    #[inline(always)]
    unsafe fn row_end_units(
        haystack: *const u8,
        offset: usize,
        previous_byte: i32,
        crlf: bool,
        units_at: i32,
        cell_start: i32,
    ) -> i32 {
        if !crlf {
            return units_at;
        }

        let before = if offset == 0 { previous_byte } else { *haystack.add(offset - 1) as i32 };

        if before == 0x0D && units_at - 1 >= cell_start {
            units_at - 1
        } else {
            units_at
        }
    }

    while cursor + 16 <= haystack_len {
        let chunk = v128_load(haystack.add(cursor) as *const v128);
        let row_mask = i8x16_bitmask(i8x16_eq(chunk, row_splat)) as u32;
        let col_mask = i8x16_bitmask(i8x16_eq(chunk, col_splat)) as u32;
        let quote_mask = if quote_enabled {
            i8x16_bitmask(i8x16_eq(chunk, quote_splat)) as u32
        } else {
            0
        };
        let cont_mask = i8x16_bitmask(u8x16_eq(v128_and(chunk, cont_mask_splat), cont_value_splat)) as u32;
        let noncont_mask = !cont_mask & 0xFFFF;
        let four_mask = i8x16_bitmask(u8x16_ge(chunk, four_splat)) as u32;
        let chunk_units = (noncont_mask.count_ones() + four_mask.count_ones()) as i32;
        let mut matches = row_mask | col_mask | quote_mask;

        while matches != 0 {
            let position = matches.trailing_zeros();
            let offset = cursor + position as usize;
            let before_mask = (1u32 << position) - 1;
            let units_at = units + ((noncont_mask & before_mask).count_ones() + (four_mask & before_mask).count_ones()) as i32;
            let is_row = (row_mask >> position) & 1 != 0;
            let is_col = (col_mask >> position) & 1 != 0;

            if is_row || is_col {
                if !quoted {
                    let end_units = if is_row {
                        row_end_units(haystack, offset, previous_byte, crlf, units_at, cell_start)
                    } else {
                        units_at
                    };

                    if !close_cell(results, &mut count, max_cells, &mut cell_start, &mut has_quote, units_at, end_units, is_row) {
                        write_cell_scan_state(results, offset, units_at, quoted, cell_start, has_quote);
                        return count;
                    }

                    if count >= max_cells {
                        // The result buffer is now full. The cursor is immediately after the
                        // delimiter that filled it — one ASCII byte, one unit past this position.
                        write_cell_scan_state(results, offset + 1, units_at + 1, quoted, cell_start, has_quote);
                        return count;
                    }
                }
            } else {
                quoted = !quoted;
                has_quote = true;
            }

            matches &= matches - 1;
        }

        units += chunk_units;
        cursor += 16;
    }

    while cursor < haystack_len {
        let byte = *haystack.add(cursor);
        let mut just_filled = false;

        if byte == row_byte || byte == col_byte {
            if !quoted {
                let is_row = byte == row_byte;
                let end_units = if is_row {
                    row_end_units(haystack, cursor, previous_byte, crlf, units, cell_start)
                } else {
                    units
                };

                if !close_cell(results, &mut count, max_cells, &mut cell_start, &mut has_quote, units, end_units, is_row) {
                    write_cell_scan_state(results, cursor, units, quoted, cell_start, has_quote);
                    return count;
                }

                just_filled = count >= max_cells;
            }
        } else if quote_enabled && byte == quote_byte {
            quoted = !quoted;
            has_quote = true;
        }

        units += byte_units(byte);
        cursor += 1;

        if just_filled {
            // The result buffer is now full. The cursor is immediately after the delimiter
            // that filled it, which was just accounted for above.
            write_cell_scan_state(results, cursor, units, quoted, cell_start, has_quote);
            return count;
        }
    }

    write_cell_scan_state(results, haystack_len, units, quoted, cell_start, has_quote);
    count
}

#[inline]
unsafe fn write_cell_scan_state(
    results: *mut i32,
    cursor: usize,
    units: i32,
    inside_quotes: bool,
    cell_start_units: i32,
    cell_has_quote: bool,
) {
    *results = cursor as i32;
    *results.add(1) = units;
    *results.add(2) = if inside_quotes { 1 } else { 0 };
    *results.add(3) = cell_start_units;
    *results.add(4) = if cell_has_quote { 1 } else { 0 };
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

// ── Multi-byte scan ───────────────────────────────────────────

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
                let mut ok = true;
                for j in 0..pat_len {
                    if *haystack.add(candidate + j) != *pattern.add(j) {
                        ok = false;
                        break;
                    }
                }
                if ok {
                    return candidate as i32;
                }
            }
            bits &= bits - 1;
        }
        offset += 16;
    }
    for i in offset..search_end {
        if *haystack.add(i) == *pattern {
            let mut ok = true;
            for j in 1..pat_len {
                if *haystack.add(i + j) != *pattern.add(j) {
                    ok = false;
                    break;
                }
            }
            if ok {
                return i as i32;
            }
        }
    }
    -1
}
