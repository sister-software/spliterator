/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import type { AsyncSequence } from "../../lib/iterators/AsyncSequence.js"

/**
 * Libuv's threadpool size: the real ceiling on concurrent filesystem calls in Node.
 *
 * {@linkcode AsyncSequence.parallelMap} / {@linkcode AsyncSequence.parallelFilter} use this as their default
 * `concurrency` in Node. It reflects `UV_THREADPOOL_SIZE` (default 4), not CPU count.
 */
export function fsConcurrency(): number {
	const raw = process.env.UV_THREADPOOL_SIZE

	if (raw === undefined) return UV_THREADPOOL_DEFAULT

	const parsed = Number.parseInt(raw, 10)

	if (Number.isNaN(parsed) || parsed === 0) return 1

	return parsed < 0 || parsed > UV_THREADPOOL_MAX ? UV_THREADPOOL_MAX : parsed
}

const UV_THREADPOOL_DEFAULT = 4
const UV_THREADPOOL_MAX = 1024
