/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

/**
 * Throws on a timer after the call has finished, so the error lands on an idle worker.
 */
export function handleItem(x: number) {
	setTimeout(() => {
		throw new Error("late boom from idle worker")
	}, 30)

	return x
}
