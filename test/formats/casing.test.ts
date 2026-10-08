/**
 * @license MIT
 * @file `smartSnakeCase` over scripts that have no case. A caseless script takes the all-caps branch, because
 *   `toUpperCase()` is the identity on Korean, Japanese, Chinese, Hebrew and Arabic. That branch used `\W`, which is
 *   `[^A-Za-z0-9_]` in JavaScript with or without the `u` flag, so every character of such a header was replaced:
 *   `영업상태명` became `_`, and a file of Korean headers became `_`, `__2`, `__3` … once `normalizeColumnNames`
 *   de-duplicated the collisions. The header was not renamed, it was destroyed, and every value in the file became
 *   unreachable by name.
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import {
	camelCase,
	capitalCase,
	isLowerCase,
	isUniformlyCased,
	isUpperCase,
	matchCase,
	normalizeColumnNames,
	sentenceCase,
	smartCapitalCase,
	smartSnakeCase,
	snakeCase,
	titleCase,
	titleCaseIfUpper,
} from "spliterator"
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

describe("snakeCase and camelCase", () => {
	// The in-house port of change-case's word splitting. These were checked against change-case 5.4.4 when the
	// dependency was dropped; a difference here is a regression against what 7.14.0 shipped.
	it.each([
		["fooBar", "foo_bar", "fooBar"],
		["FooBar", "foo_bar", "fooBar"],
		["FOO_BAR", "foo_bar", "fooBar"],
		["XMLHttpRequest", "xml_http_request", "xmlHttpRequest"],
		["version2Beta", "version2_beta", "version2Beta"],
		["2fast", "2fast", "2fast"],
		["a1B2c3", "a1_b2c3", "a1B2c3"],
		["  hello--world  ", "hello_world", "helloWorld"],
		["résumé Café", "résumé_café", "résuméCafé"],
		["", "", ""],
		["___", "", ""],
	])("splits %j", (input, snake, camel) => {
		expect(snakeCase(input)).toBe(snake)
		expect(camelCase(input)).toBe(camel)
	})

	it("guards a digit-leading word in camelCase, as change-case did", () => {
		expect(camelCase("point 3d")).toBe("point_3d")
	})
})

describe("titleCase", () => {
	it.each([
		["hello world", "Hello World"],
		["HELLO WORLD", "Hello World"],
		["o'brien", "O'Brien"],
		["mcdonald's", "Mcdonald's"],
		["MCDONALD'S", "Mcdonald's"],
		["DON'T", "Don't"],
		["rock 'n' roll", "Rock 'n' Roll"],
		["d'angelo", "D'Angelo"],
		["it’s", "It’s"],
		["123abc def", "123Abc Def"],
		["first_name", "First Name"],
		["FIRST_NAME__X", "First Name  X"],
		["한글 name", "한글 Name"],
		["", ""],
		["straße", "Straße"],
	])("titlecases each Latin run of %j", (input, expected) => {
		expect(titleCase(input)).toBe(expected)
	})

	it("keeps a run whose conversion would change its length", () => {
		expect(titleCase("ßtraße")).toBe("ßtraße")
		expect(titleCase("ANKARA İZMİR")).toBe("Ankara İZMİR")
	})

	it("keeps or uppercases short runs on request", () => {
		expect(titleCase("1600 pennsylvania AVE NW, washington DC", { shortLength: 2 })).toBe(
			"1600 Pennsylvania Ave NW, Washington DC"
		)

		expect(titleCase("1600 pennsylvania ave nw, washington dc", { shortLength: 2, short: "upper" })).toBe(
			"1600 Pennsylvania Ave NW, Washington DC"
		)
	})

	it("works as an array callback", () => {
		expect(["hello", "WORLD"].map(titleCase)).toEqual(["Hello", "World"])
	})

	it("keeps a locale's particles lowercase after the first word", () => {
		const gb = new Set(["upon", "super", "on", "the"])
		const fr = new Set(["de", "la", "l", "d", "sur"])

		expect(titleCase("STRATFORD-UPON-AVON", { particles: gb })).toBe("Stratford-upon-Avon")
		expect(titleCase("WESTON-SUPER-MARE", { particles: gb })).toBe("Weston-super-Mare")
		expect(titleCase("THE MUMBLES", { particles: gb })).toBe("The Mumbles")
		expect(titleCase("BISHOP'S STORTFORD", { particles: gb })).toBe("Bishop's Stortford")
		expect(titleCase("villeneuve-l'archevêque", { particles: fr })).toBe("Villeneuve-l'Archevêque")
		expect(titleCase("SAINT-JEAN-DE-LA-RUELLE", { particles: fr })).toBe("Saint-Jean-de-la-Ruelle")
		expect(titleCase("de la salle", { particles: fr })).toBe("De la Salle")
	})
})

describe("matchCase", () => {
	it.each([
		["AVE", "avenue", "AVENUE"],
		["ave", "AVENUE", "avenue"],
		["Ave", "avenue", "Avenue"],
		["aVe", "AVENUE", "Avenue"],
		["123", "avenue", "AVENUE"],
		["", "avenue", "avenue"],
	])("shapes the target like %j", (reference, target, expected) => {
		expect(matchCase(target, reference)).toBe(expected)
	})
})

describe("capitalCase", () => {
	it.each([
		["firstName", "First Name"],
		["first_name", "First Name"],
		["FIRST_NAME", "First Name"],
		["XMLHttpRequest", "Xml Http Request"],
		["date of birth", "Date Of Birth"],
		["  hello--world  ", "Hello World"],
		["", ""],
	])("labels %j", (input, expected) => {
		expect(capitalCase(input)).toBe(expected)
	})
})

describe("sentenceCase", () => {
	it.each([
		["afghan_restaurant", "Afghan restaurant"],
		["afghanRestaurant", "Afghan restaurant"],
		["AFGHAN_RESTAURANT", "Afghan restaurant"],
		["afghan restaurant", "Afghan restaurant"],
		["", ""],
	])("labels %j", (input, expected) => {
		expect(sentenceCase(input)).toBe(expected)
	})
})

describe("case predicates", () => {
	it.each([
		["ABC", true, false, true],
		["abc", false, true, true],
		["Abc", false, false, false],
		["ABC-123", true, false, true],
		["123", false, false, true],
		["한글", false, false, true],
		["", false, false, false],
	])("%j → isUpperCase %s, isLowerCase %s, isUniformlyCased %s", (input, upper, lower, uniform) => {
		expect(isUpperCase(input)).toBe(upper)
		expect(isLowerCase(input)).toBe(lower)
		expect(isUniformlyCased(input)).toBe(uniform)
	})

	it("treats null as not uniformly cased", () => {
		expect(isUniformlyCased(null)).toBe(false)
	})

	it("applies a cased-letter floor", () => {
		expect(isUpperCase("NY", { minimumCased: 3 })).toBe(false)
		expect(isUpperCase("214 JONES RD", { minimumCased: 3 })).toBe(true)
		expect(isLowerCase("dc", { minimumCased: 3 })).toBe(false)
	})

	it("gates on script", () => {
		expect(isUpperCase("RUE DU FAUBOURG SAINT-HONORÉ", { script: "latin" })).toBe(true)
		expect(isUpperCase("RUE DU FAUBOURG SAINT-HONORÉ", { script: "ascii" })).toBe(false)
		expect(isUpperCase("ΑΘΗΝΑ 123 RD", { script: "latin" })).toBe(false)
		expect(isLowerCase("café", { script: "ascii" })).toBe(false)
		expect(isLowerCase("café")).toBe(true)
	})

	it("works as an array callback", () => {
		expect(["a", "b", "c", "D"].some(isUpperCase)).toBe(true)
		expect(["a", "b", "c", "D"].every(isLowerCase)).toBe(false)
		expect(["a", "b", "c"].every(isLowerCase)).toBe(true)
	})
})

describe("titleCaseIfUpper", () => {
	it("titlecases only a shouted field", () => {
		expect(titleCaseIfUpper("MAIN STREET")).toBe("Main Street")
		expect(titleCaseIfUpper("Main street")).toBe("Main street")
		expect(titleCaseIfUpper("main street")).toBe("main street")
		expect(titleCaseIfUpper("123")).toBe("123")
	})
})

describe("smartCapitalCase", () => {
	it("titlecases mixed-case input and leaves uniform input and email addresses alone", () => {
		expect(smartCapitalCase("john sMith")).toBe("John Smith")
		expect(smartCapitalCase("JOHN SMITH")).toBe("JOHN SMITH")
		expect(smartCapitalCase("john smith")).toBe("john smith")
		expect(smartCapitalCase("John@Example.com")).toBe("John@Example.com")
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
