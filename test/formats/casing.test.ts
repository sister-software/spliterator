/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 * @file `smartSnakeCase` over scripts that have no case.
 *
 *   A caseless script takes the all-caps branch, because `toUpperCase()` is the identity on Korean, Japanese, Chinese,
 *   Hebrew and Arabic. That branch used `\W`, which is `[^A-Za-z0-9_]` in JavaScript with or without the `u` flag, so
 *   every character of such a header was replaced: `영업상태명` became `_`, and a file of Korean headers became `_`,
 *   `__2`, `__3` … once `normalizeColumnNames` de-duplicated the collisions. The header was not renamed, it was
 *   destroyed, and every value in the file became unreachable by name.
 */

import { normalizeColumnNames, smartSnakeCase } from "spliterator"
import { describe, expect, it } from "vitest"

describe("smartSnakeCase", () => {
	it.each([
		["Korean", "영업상태명"],
		["Korean, another", "도로명주소"],
		["Chinese", "所在地"],
		["Japanese", "住所"],
		["Hebrew", "כתובת"],
		["Arabic", "عنوان"],
	])("keeps a %s header as written", (_label, header) => {
		expect(smartSnakeCase(header)).toBe(header)
	})

	it("still replaces what cannot be part of a key, in any script", () => {
		expect(smartSnakeCase("좌표정보(X)")).toBe("좌표정보_X_")
	})

	it("strips the periods of a dotted acronym, as the docstring says", () => {
		// The all-caps branch read `name` rather than the period-stripped `normalizedName`, so this answered `U_S_A_`
		// and contradicted the example above it. Fixed in mailwoman's forked copy on 2026-06-25 and never carried back.
		expect(smartSnakeCase("U.S.A.")).toBe("USA")
	})

	it.each([
		["an all-caps column", "LON", "LON"],
		["another", "NUMBER", "NUMBER"],
		["a spaced name", "First Name", "first_name"],
		["a camel name", "firstName", "first_name"],
	])("leaves ASCII behaviour alone: %s", (_label, input, expected) => {
		expect(smartSnakeCase(input)).toBe(expected)
	})
})

describe("normalizeColumnNames", () => {
	it("keeps caseless headers distinct, where they used to collide into one key", () => {
		expect(normalizeColumnNames(["영업상태명", "도로명주소", "지번주소"])).toEqual([
			"영업상태명",
			"도로명주소",
			"지번주소",
		])
	})

	it("still de-duplicates a genuine repeat", () => {
		expect(normalizeColumnNames(["name", "name"])).toEqual(["name", "name_2"])
	})
})
