/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type CharacterSequenceInput, Delimiters } from "./CharacterSequence.js"
import {
	CSVSpliterator,
	type CSVSpliteratorEmittedRecord,
	type CSVSpliteratorInit,
	type RowTuple,
} from "./CSVSpliterator.js"
import { type AsyncChunkIterator, type AsyncDataResource } from "./shared.js"
import { type AsyncSpliteratorInit } from "./Spliterator.js"

/**
 * A spliterator for tab-separated values, equivalent to {@linkcode CSVSpliterator} with the column
 * delimiter defaulted to {@linkcode Delimiters.Tab}. Callers can still override
 * {@linkcode CSVSpliteratorInit.columnDelimiter} when a file uses a non-tab separator.
 */
export abstract class TSVSpliterator extends CSVSpliterator {
	static override from<T extends CSVSpliteratorEmittedRecord = CSVSpliteratorEmittedRecord>(
		source: CharacterSequenceInput,
		options?: CSVSpliteratorInit & { mode: "object" }
	): Generator<T>
	static override from<T extends RowTuple[] = RowTuple[]>(
		source: CharacterSequenceInput,
		options?: CSVSpliteratorInit & { mode: "entries" }
	): Generator<T>
	static override from<T extends string[] = string[]>(
		source: CharacterSequenceInput,
		options?: CSVSpliteratorInit & { mode?: "array" }
	): Generator<T>
	static override from(source: CharacterSequenceInput, init: CSVSpliteratorInit = {}) {
		return CSVSpliterator.from(source, withTabDefault(init) as CSVSpliteratorInit & { mode?: "array" })
	}

	static override fromAsync<T extends CSVSpliteratorEmittedRecord = CSVSpliteratorEmittedRecord>(
		source: AsyncDataResource | AsyncChunkIterator,
		options?: CSVSpliteratorInit & AsyncSpliteratorInit & { mode: "object" }
	): AsyncGenerator<T>
	static override fromAsync<T extends RowTuple[] = RowTuple[]>(
		source: AsyncDataResource | AsyncChunkIterator,
		options?: CSVSpliteratorInit & AsyncSpliteratorInit & { mode: "entries" }
	): AsyncGenerator<T>
	static override fromAsync<T extends string[] = string[]>(
		source: AsyncDataResource | AsyncChunkIterator,
		options?: CSVSpliteratorInit & AsyncSpliteratorInit & { mode?: "array" }
	): AsyncGenerator<T>
	static override fromAsync(
		source: AsyncDataResource | AsyncChunkIterator,
		init?: CSVSpliteratorInit & AsyncSpliteratorInit
	): AsyncGenerator<unknown>
	static override fromAsync(
		source: AsyncDataResource | AsyncChunkIterator,
		init: CSVSpliteratorInit & AsyncSpliteratorInit = {}
	) {
		return CSVSpliterator.fromAsync(source, withTabDefault(init))
	}
}

function withTabDefault<T extends CSVSpliteratorInit>(init: T): T {
	if (init.columnDelimiter === undefined) {
		return { ...init, columnDelimiter: Delimiters.Tab }
	}

	return init
}
