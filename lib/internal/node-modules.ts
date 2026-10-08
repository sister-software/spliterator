/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

/**
 * Lazy loaders for the Node-only modules the isomorphic core reaches at call time.
 *
 * The specifier is a variable, and the call carries both ignore comments, because Vite and webpack follow a dynamic
 * `import("node:...")` with a literal specifier into the bundle and warn about it just as they would a static import.
 * `test/package/static-graph.test.ts` fails on a literal form reappearing anywhere under the root or `./web` entries.
 */

type NodeFs = typeof import("spliterator/node/fs")

type WorkerThreads = typeof import("node:worker_threads")

type NodeUrl = typeof import("node:url")

type NodeStream = typeof import("node:stream")

/**
 * Import a module by a specifier no bundler can see through. Use it for anything that must stay out of a browser
 * bundle: Node built-ins, the `spliterator/node/fs` adapter, and optional vendor peers.
 */
export function loadHidden<T = unknown>(specifier: string): Promise<T> {
	return import(/* webpackIgnore: true */ /* @vite-ignore */ specifier)
}

/**
 * Resolve a sibling module's URL without a bundler chasing it as an asset. Vite only rewrites `new URL(literal,
 * import.meta.url)`, so routing the path through a parameter is enough.
 */
export function siblingUrl(relativePath: string, base: string): URL {
	return new URL(relativePath, base)
}

const NODE_FS = "spliterator/node/fs"
const WORKER_THREADS = "node:worker_threads"
const NODE_URL = "node:url"
const NODE_STREAM = "node:stream"

/**
 * The `spliterator/node/fs` adapter. Rejects outside Node.
 */
export function loadNodeFs(): Promise<NodeFs> {
	return loadHidden<NodeFs>(NODE_FS)
}

/**
 * `node:worker_threads`. Rejects outside Node.
 */
export function loadWorkerThreads(): Promise<WorkerThreads> {
	return loadHidden<WorkerThreads>(WORKER_THREADS)
}

/**
 * `node:url`. Rejects outside Node.
 */
export function loadNodeUrl(): Promise<NodeUrl> {
	return loadHidden<NodeUrl>(NODE_URL)
}

/**
 * `node:stream`. Rejects outside Node.
 */
export function loadNodeStream(): Promise<NodeStream> {
	return loadHidden<NodeStream>(NODE_STREAM)
}
