/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
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
