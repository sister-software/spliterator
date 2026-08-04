/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

/**
 * Convenience function to await an async iterable.
 */
export async function iterateInParallel<T>(asyncIterable: AsyncIterable<T>): Promise<void> {
	for await (const _ of asyncIterable) {
		/* empty */
	}
}

/**
 * Type-predicate for checking if a value is iterable.
 *
 * @category Type Guard
 * @category Object
 */
export function isIterable<T>(input: unknown): input is Iterable<T> {
	return Symbol.iterator in new Object(input)
}

/**
 * Iterable that can be checked for the existence of a member.
 */
export interface IndexedIterable<T = unknown> extends Iterable<T> {
	has(value: T): boolean
}

/**
 * Type-predicate for checking if an member within an iterable can be checked for existence.
 */
export function isIndexedIterable<T>(value: Iterable<T>): value is IndexedIterable<T> {
	return value && typeof (value as IndexedIterable).has === "function"
}

/**
 * Extracts the property keys of an object that are of type `number`.
 */
export type NumericProperties<T> = {
	[K in keyof T]: T[K] extends number ? K : never
}[keyof T]

/**
 * Given an iterable of objects, returns the sum of the specified property.
 */
export function sumOf<T extends object>(iterable: Iterable<T>, prop: NumericProperties<T>): number {
	let total = 0

	for (const item of iterable) {
		total += item[prop] as number
	}

	return total
}
