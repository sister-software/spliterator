/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
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
 * The file URL of a worker entry named by its `#` import-map specifier, so the same specifier serves the source tree
 * under the `node` condition and the compiled tree under `default`. Taking the specifier as a parameter keeps a bundler
 * from chasing it as an asset.
 *
 * Resolved through `createRequire`, not `import.meta.resolve`. Tools that transpile this package to CommonJS on the fly
 * (jiti, which Docusaurus loads its plugins through) rewrite `import.meta.url` and leave `import.meta.resolve` in
 * place, and Node then refuses the rewritten file with "Cannot use 'import.meta' outside a module". That took down a
 * consumer's docs build on 9.1.0. `require.resolve` honours the package's `#` import map the same way. The built-ins
 * come through `process.getBuiltinModule` so this stays synchronous and the root keeps no static `node:` import.
 */
export function workerEntryUrl(specifier: string): URL {
	const { createRequire } = process.getBuiltinModule("node:module")
	const { pathToFileURL } = process.getBuiltinModule("node:url")

	return pathToFileURL(createRequire(import.meta.url).resolve(specifier))
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
