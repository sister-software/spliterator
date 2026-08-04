/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

/**
 * Given an iterable of values, maps each value to a record of the value and the result of the callback.
 *
 * This is a convenience function when an iterable needs mapping to an object-like structure.
 *
 * ```ts
 * const iterable = ["a", "b", "c"]
 * const result = pivot(iterable, (value) => value.toUpperCase())
 *
 * // { a: "A", b: "B", c: "C" }
 * ```
 *
 * @category Collections
 * @category Object
 */
export function pivot<T extends PropertyKey, C extends (value: T) => Promise<unknown> | unknown>(
	/**
	 * The iterable to pivot.
	 */
	iterable: Iterable<T>,
	/**
	 * The callback to transform each value.
	 */
	callback: C
): ReturnType<C> extends PromiseLike<infer U> ? Promise<Record<T, U>> : Record<T, ReturnType<C>> {
	const entries: Array<[T, ReturnType<C>]> = []
	let foundThenable = false

	for (const value of iterable) {
		const result = callback(value)

		if (result && typeof result === "object" && "then" in result) {
			foundThenable = true
		}

		entries.push([value, result as ReturnType<C>])
	}

	if (foundThenable) {
		return Promise.all(
			entries.map(([key, value]) => {
				return Promise.resolve(value).then((resolvedValue) => [key, resolvedValue] as const)
			})
		).then(Object.fromEntries) as unknown as ReturnType<C> extends PromiseLike<infer U>
			? Promise<Record<T, U>>
			: Record<T, ReturnType<C>>
	}

	const pivotedRecord = Object.fromEntries(entries)

	return pivotedRecord as unknown as ReturnType<C> extends PromiseLike<infer U>
		? Promise<Record<T, U>>
		: Record<T, ReturnType<C>>
}
