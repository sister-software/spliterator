/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

/**
 * Merge several async iterables, pulling from **all of them concurrently** and yielding each value as soon as it
 * arrives (completion order, not source order). An error from any source rejects; remaining sources are returned
 * (cancelled) on completion, error, or early break.
 */
export async function* mergeAsyncIterators<R>(sources: Array<AsyncIterable<R>>): AsyncIterableIterator<R> {
	const advance = (it: AsyncIterator<R>) => it.next().then((result) => ({ it, result }))
	const pending = new Map<AsyncIterator<R>, Promise<{ it: AsyncIterator<R>; result: IteratorResult<R> }>>()

	for (const source of sources) {
		const it = source[Symbol.asyncIterator]()
		pending.set(it, advance(it))
	}

	try {
		while (pending.size > 0) {
			const { it, result } = await Promise.race(pending.values())

			if (result.done) {
				pending.delete(it)
			} else {
				yield result.value
				pending.set(it, advance(it))
			}
		}
	} finally {
		// Stop any iterators we didn't drain (early break / error). Swallow rejections from their
		// in-flight `next()` so they don't surface as unhandled.
		for (const promise of pending.values()) void promise.catch(() => {})

		await Promise.allSettled(Array.from(pending.keys(), (it) => it.return?.()))
	}
}
