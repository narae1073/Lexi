/**
 * Wordbook worker boundary.
 *
 * Sorting and searching a 116k-entry projection on the main thread would make
 * every keystroke and every first open wait on the whole list. The UI sends the
 * projection once per language to this worker; the worker keeps a compact sorted
 * index (lemma + surfaces) and answers searches with matching lemmas. The main
 * thread only maps those lemmas back to rows it already holds, so a status edit
 * never has to re-send the projection.
 *
 * Document progress is also computed here: it walks projection contexts (not
 * occurrence rows), so a paged document with no local content still gets a
 * gauge.
 *
 * Local-only mode (Task 11) builds the same projection in the same worker. The
 * producer posts the device's occurrence rows once, then only the documents that
 * changed; the worker keeps the language's source rows and recomputes just the
 * affected lemmas. That keeps a one-document edit proportional to the document
 * instead of to a 200k-row language.
 *
 * `handleWordbookRequest` is pure so tests (and the no-Worker fallback) can use
 * the exact same semantics. The module only installs a `message` listener when
 * it is actually running inside a worker.
 */

import type { WordOccurrence } from '../../app/stores/occurrences'
import type { WordbookEntry } from './buildWordbook'
import {
  buildLocalProjection,
  type LocalProjectionBuild,
  type LocalProjectionRequest,
  type LocalWordState,
} from './localProjection'
import {
  compareWordbookEntries,
  computeDocumentProgress,
  type DocumentProgress,
  type ProgressDocument,
  type ProgressEntry,
  type ProjectionEntry,
} from './wordbookProjection'

export type WordbookWorkerRequest =
  | {
      type: 'rebuild'
      entries: readonly WordbookEntry[]
      /** Locale used for sorting; defaults to the runtime locale. */
      languageCode?: string
    }
  | ({
      type: 'local-rebuild'
      languageCode: string
    } & LocalProjectionRequest)
  | {
      /**
       * Releases the worker's local-only source and search dataset.
       *
       * Sent when the device stops being local-only (it links an account) or
       * when tests tear a producer down. Without it the worker would keep a
       * 200k-occurrence language and its index alive for the rest of the page.
       */
      type: 'local-clear'
      languageCode?: string
    }
  | {
      type: 'search'
      query: string
      languageCode?: string
    }
  | {
      type: 'progress'
      /**
       * Optional explicit entries. Without them the worker uses every dataset it
       * has rebuilt, which lets a caller request progress with `{ type: 'progress' }`.
       */
      entries?: readonly WordbookEntry[]
      /** Live document metadata; contexts for deleted/unknown ids are ignored. */
      documents?: readonly ProgressDocument[]
      /**
       * Status overrides keyed `${languageCode}::${lemma}`.
       *
       * A status tap patches one row on the main thread. Re-sending 116k entries
       * would defeat that; the worker keeps the rebuilt dataset and applies this
       * small map instead.
       */
      statuses?: Record<string, ProgressEntry['status']>
    }

export type WordbookWorkerResponse =
  | { type: 'rebuilt'; total: number; id?: number }
  | ({
      type: 'local-rebuilt'
      id?: number
    } & LocalProjectionBuild)
  | { type: 'local-cleared'; id?: number }
  | { type: 'search'; lemmas: string[]; total: number; id?: number }
  | { type: 'progress'; progress: Record<string, DocumentProgress>; id?: number }
  | { type: 'error'; message: string; id?: number }

type RequestEnvelope = WordbookWorkerRequest & { id?: number }
type ResponseEnvelope = WordbookWorkerResponse & { id?: number }

type IndexEntry = {
  lemma: string
  haystack: string
}

/**
 * What the search index needs.
 *
 * Projection rows (`wordbookEntries`) and occurrence-built rows (`buildWordbook`)
 * both have these two fields; the index never looks at the rest.
 */
export type WorkerDatasetEntry = {
  lemma: string
  surfaces: readonly string[]
}

type Dataset = {
  entries: readonly WorkerDatasetEntry[]
  /** Sorted lazily for local builds — `null` means "sort on the next search". */
  index: IndexEntry[] | null
  /**
   * Document progress from these entries without status overrides.
   *
   * DocumentList requests progress on every app start. Recomputing the same
   * 25k-row/200k-context projection for an unchanged dataset was the difference
   * between the 100 ms target and a measured ~145 ms; the rebuild now pays the
   * cost once and the request filters the cached map.
   */
  progress: Map<string, DocumentProgress> | null
}

/**
 * One language's local-only source rows.
 *
 * Keeping occurrences by document (and by lemma) is what makes a document edit
 * recompute only that document's lemmas: no scan of the whole language, and a
 * shared lemma still reads every document it occurs in.
 */
type LocalDataset = {
  occurrences: Map<string, WordOccurrence[]>
  byLemma: Map<string, WordOccurrence[]>
  states: Map<string, LocalWordState>
  entries: Map<string, ProjectionEntry>
}

export type WordbookWorkerState = {
  datasets: Map<string, Dataset>
  /** Local-only sources. Account mode never populates this map. */
  local: Map<string, LocalDataset>
}

export function createWordbookWorkerState(): WordbookWorkerState {
  return { datasets: new Map(), local: new Map() }
}

const DEFAULT_LANGUAGE = ''

function indexOf(
  entries: readonly WorkerDatasetEntry[],
  languageCode: string,
): IndexEntry[] {
  const index = entries.map((entry) => ({
    lemma: entry.lemma,
    haystack: `${entry.lemma}\n${entry.surfaces.join('\n')}`.toLowerCase(),
  }))
  return index.sort((a, b) => compareWordbookEntries(a, b, languageCode))
}

function createLocalDataset(): LocalDataset {
  return {
    occurrences: new Map(),
    byLemma: new Map(),
    states: new Map(),
    entries: new Map(),
  }
}

/** Adds one occurrence row to a local dataset. Rows are kept by reference. */
function addOccurrence(dataset: LocalDataset, row: WordOccurrence): void {
  const documentRows = dataset.occurrences.get(row.documentId)
  if (documentRows) documentRows.push(row)
  else dataset.occurrences.set(row.documentId, [row])

  const lemmaRows = dataset.byLemma.get(row.lemma)
  if (lemmaRows) lemmaRows.push(row)
  else dataset.byLemma.set(row.lemma, [row])
}

/** Removes one document's rows; returns the lemmas it contributed. */
function removeDocument(dataset: LocalDataset, documentId: string): string[] {
  const rows = dataset.occurrences.get(documentId)
  if (!rows) return []
  dataset.occurrences.delete(documentId)

  const lemmas: string[] = []
  for (const row of rows) {
    lemmas.push(row.lemma)
    const lemmaRows = dataset.byLemma.get(row.lemma)
    if (!lemmaRows) continue
    const next = lemmaRows.filter((item) => item !== row)
    if (next.length === 0) dataset.byLemma.delete(row.lemma)
    else dataset.byLemma.set(row.lemma, next)
  }
  return lemmas
}

/** True when two builds of the same lemma produced the same row. */
function sameProjectionEntry(a: ProjectionEntry, b: ProjectionEntry): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Builds (or incrementally updates) one language's local projection.
 *
 * A request without `documentIds`/`removedDocumentIds` is a full rebuild: it
 * replaces the language's source rows and returns every row. A request with
 * either field touches only those documents and returns only the lemmas whose
 * row changed — that is the "one document edit updates only its entries" rule.
 */
function handleLocalRebuild(
  state: WordbookWorkerState,
  request: WordbookWorkerRequest & { type: 'local-rebuild' },
): WordbookWorkerResponse {
  const { languageCode } = request
  const full =
    request.documentIds === undefined && request.removedDocumentIds === undefined
  let dataset = state.local.get(languageCode)
  if (!dataset) {
    dataset = createLocalDataset()
    state.local.set(languageCode, dataset)
  }

  const changed: ProjectionEntry[] = []
  const removed: string[] = []
  const rows = request.occurrences.filter((row) => row.languageCode === languageCode)

  if (full) {
    dataset.occurrences.clear()
    dataset.byLemma.clear()
    dataset.states.clear()
    for (const row of rows) addOccurrence(dataset, row)
    for (const wordState of request.wordStates ?? []) {
      dataset.states.set(wordState.lemma, wordState)
    }
    for (const entry of buildLocalProjection(rows, request.wordStates ?? [])) {
      dataset.entries.set(entry.lemma, entry)
      changed.push(entry)
    }
  } else {
    const affected = new Set<string>()
    for (const documentId of request.removedDocumentIds ?? []) {
      for (const lemma of removeDocument(dataset, documentId)) affected.add(lemma)
    }
    for (const documentId of request.documentIds ?? []) {
      for (const lemma of removeDocument(dataset, documentId)) affected.add(lemma)
    }
    for (const wordState of request.wordStates ?? []) {
      // Merge rather than replace: a state edit from the store carries the
      // display fields but not every watermark the row may already have.
      const previous = dataset.states.get(wordState.lemma)
      dataset.states.set(wordState.lemma, previous ? { ...previous, ...wordState } : wordState)
    }
    for (const row of rows) {
      addOccurrence(dataset, row)
      affected.add(row.lemma)
    }

    for (const lemma of affected) {
      const lemmaRows = dataset.byLemma.get(lemma) ?? []
      const previous = dataset.entries.get(lemma)
      if (lemmaRows.length === 0) {
        if (previous !== undefined) {
          dataset.entries.delete(lemma)
          removed.push(lemma)
        }
        continue
      }
      const wordState = dataset.states.get(lemma)
      const built = buildLocalProjection(lemmaRows, wordState ? [wordState] : [])[0]
      if (!built) continue
      if (previous !== undefined && sameProjectionEntry(previous, built)) continue
      dataset.entries.set(lemma, built)
      changed.push(built)
    }
  }

  const entries = [...dataset.entries.values()]
  if (full || changed.length > 0 || removed.length > 0) {
    // The search dataset shares these rows. The index is invalidated rather than
    // re-sorted here: the next search pays that cost once, so a document edit
    // stays proportional to the document, not to the language.
    state.datasets.set(languageCode, { entries, index: null, progress: null })
  }

  const build: LocalProjectionBuild = {
    entries: changed,
    removed,
    total: entries.length,
    full,
  }
  return { type: 'local-rebuilt', ...build }
}

/**
 * The one implementation of the worker protocol.
 *
 * Shared by the real worker, the inline fallback used where `Worker` does not
 * exist (unit tests, SSR), and tests that assert the protocol directly.
 */
export function handleWordbookRequest(
  state: WordbookWorkerState,
  request: WordbookWorkerRequest,
): WordbookWorkerResponse {
  if (request.type === 'rebuild') {
    const languageCode = request.languageCode ?? DEFAULT_LANGUAGE
    state.datasets.set(languageCode, {
      entries: request.entries,
      index: indexOf(request.entries, languageCode),
      // Progress is part of the same rebuild: DocumentList asks for it right
      // after app start, and walking 200k contexts inside that request was the
      // difference between a 62 ms and a 100+ ms round trip.
      progress: computeDocumentProgress(
        request.entries as unknown as readonly ProgressEntry[],
      ),
    })
    // An account projection replaces any local-only rows for the language: after
    // a device links an account, the server copy is the authority.
    state.local.delete(languageCode)
    return { type: 'rebuilt', total: request.entries.length }
  }

  if (request.type === 'local-rebuild') return handleLocalRebuild(state, request)

  if (request.type === 'local-clear') {
    if (request.languageCode === undefined) {
      state.local.clear()
      state.datasets.clear()
    } else {
      state.local.delete(request.languageCode)
      state.datasets.delete(request.languageCode)
    }
    return { type: 'local-cleared' }
  }

  if (request.type === 'search') {
    const languageCode = request.languageCode ?? DEFAULT_LANGUAGE
    const dataset = state.datasets.get(languageCode)
    if (!dataset) return { type: 'search', lemmas: [], total: 0 }
    if (dataset.index === null) dataset.index = indexOf(dataset.entries, languageCode)
    const needle = request.query.trim().toLowerCase()
    const lemmas: string[] = []
    for (const item of dataset.index) {
      if (needle !== '' && !item.haystack.includes(needle)) continue
      lemmas.push(item.lemma)
    }
    return { type: 'search', lemmas, total: lemmas.length }
  }

  const datasets = [...state.datasets.values()]
  const statuses = request.statuses
  /**
   * The common request has no overrides: DocumentList's status map only carries
   * rows that differ from what the worker rebuilt. Reuse the rebuild's progress
   * and filter it to the live documents instead of walking every context again.
   */
  if (request.entries === undefined && (!statuses || Object.keys(statuses).length === 0)) {
    const merged = new Map<string, DocumentProgress>()
    for (const dataset of datasets) {
      dataset.progress ??= computeDocumentProgress(
        dataset.entries as unknown as readonly ProgressEntry[],
      )
      for (const [documentId, entry] of dataset.progress) merged.set(documentId, entry)
    }
    return { type: 'progress', progress: Object.fromEntries(filterProgress(merged, request.documents)) }
  }

  const rawEntries =
    request.entries ??
    datasets.flatMap((dataset) => [...dataset.entries])
  let entries = rawEntries as unknown as readonly ProgressEntry[]
  if (statuses) {
    entries = entries.map((entry) => {
      const languageCode = (entry as { languageCode?: string }).languageCode
      if (!languageCode) return entry
      const status = statuses[`${languageCode}::${entry.lemma}`]
      return status === undefined ? entry : { ...entry, status }
    })
  }
  const progress = computeDocumentProgress(entries, request.documents)
  return { type: 'progress', progress: Object.fromEntries(progress) }
}

/** Keeps only live document ids when the caller supplies the document list. */
function filterProgress(
  progress: Map<string, DocumentProgress>,
  documents: readonly ProgressDocument[] | undefined,
): Map<string, DocumentProgress> {
  if (documents === undefined) return progress
  const allowed = new Set(documents.filter((doc) => !doc.deletedAt).map((doc) => doc.id))
  const filtered = new Map<string, DocumentProgress>()
  for (const [documentId, entry] of progress) {
    if (allowed.has(documentId)) filtered.set(documentId, entry)
  }
  return filtered
}

/** Minimal worker surface this client needs; tests provide a fake with the same shape. */
export type WorkerLike = {
  postMessage(message: unknown): void
  onmessage: ((event: { data: ResponseEnvelope }) => void) | null
  onerror?: ((event: unknown) => void) | null
  terminate?: () => void
}

export type WordbookWorkerClientOptions = {
  /** Injection point for tests. Omit for a real worker. */
  worker?: WorkerLike
  /** Force the inline implementation (tests without a Worker constructor). */
  inline?: boolean
}

function createDefaultWorker(): WorkerLike | null {
  if (typeof Worker === 'undefined') return null
  try {
    return new Worker(new URL('./wordbookWorker.ts', import.meta.url), {
      type: 'module',
    }) as unknown as WorkerLike
  } catch {
    return null
  }
}

/**
 * Promise-facing client for the worker protocol.
 *
 * If a real Worker is unavailable the client falls back to running the pure
 * handler inline. The inline path is a compatibility fallback, not a design
 * goal: production always takes the worker branch.
 */
export class WordbookWorkerClient {
  private readonly worker: WorkerLike | null
  private readonly inlineState: WordbookWorkerState | null
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (value: ResponseEnvelope) => void; reject: (error: Error) => void }
  >()
  private rebuildBarrier: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(options: WordbookWorkerClientOptions = {}) {
    if (options.worker) {
      this.worker = options.worker
    } else if (options.inline) {
      this.worker = null
    } else {
      this.worker = createDefaultWorker()
    }
    this.inlineState = this.worker ? null : createWordbookWorkerState()

    if (this.worker) {
      this.worker.onmessage = (event) => {
        const response = event.data
        const id = response.id
        if (id === undefined) return
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        if (response.type === 'error') pending.reject(new Error(response.message))
        else pending.resolve(response)
      }
      this.worker.onerror = () => {
        this.failAll(new Error('wordbook worker failed'))
      }
    }
  }

  rebuild(entries: readonly WordbookEntry[], languageCode = DEFAULT_LANGUAGE): Promise<void> {
    const request: WordbookWorkerRequest = { type: 'rebuild', entries, languageCode }
    this.rebuildBarrier = this.send(request)
    return this.rebuildBarrier.then(() => undefined)
  }

  /**
   * Builds or updates one language's local-only projection.
   *
   * The heavy part (grouping occurrences, counts, contexts, rebuilding affected
   * lemmas) runs in the worker. The returned rows are the changed set: everything
   * on a full build, only the touched lemmas on a document/state update. A search
   * that lands while this is running waits for it, exactly like `rebuild`.
   */
  localRebuild(
    languageCode: string,
    request: LocalProjectionRequest = { occurrences: [] },
  ): Promise<LocalProjectionBuild> {
    const pending = this.send({ type: 'local-rebuild', languageCode, ...request })
    this.rebuildBarrier = pending
    return pending.then((response) => {
      if (response.type !== 'local-rebuilt') throw new Error('unexpected worker response')
      return {
        entries: response.entries,
        removed: response.removed,
        total: response.total,
        full: response.full,
      }
    })
  }

  /**
   * Releases the worker's local-only source rows and search dataset.
   *
   * Called when this device links an account (the server projection takes over)
   * and by producer teardown. `languageCode` limits it to one language.
   */
  async localClear(languageCode?: string): Promise<void> {
    const response = await this.send({ type: 'local-clear', languageCode })
    if (response.type !== 'local-cleared') throw new Error('unexpected worker response')
  }

  async search(query: string, languageCode = DEFAULT_LANGUAGE): Promise<string[]> {
    // A search that lands before the rebuild finishes would answer from an empty
    // or previous dataset. Wait for the rebuild, then search.
    await this.rebuildBarrier.catch(() => undefined)
    const response = await this.send({ type: 'search', query, languageCode })
    if (response.type !== 'search') throw new Error('unexpected worker response')
    return response.lemmas
  }

  async progress(
    entries?: readonly WordbookEntry[],
    documents?: readonly ProgressDocument[],
    statuses?: Record<string, ProgressEntry['status']>,
  ): Promise<Map<string, DocumentProgress>> {
    await this.rebuildBarrier.catch(() => undefined)
    const response = await this.send({ type: 'progress', entries, documents, statuses })
    if (response.type !== 'progress') throw new Error('unexpected worker response')
    return new Map(Object.entries(response.progress))
  }

  terminate(): void {
    this.closed = true
    this.failAll(new Error('wordbook worker terminated'))
    this.worker?.terminate?.()
  }

  private send(request: WordbookWorkerRequest): Promise<ResponseEnvelope> {
    if (this.closed) return Promise.reject(new Error('wordbook worker terminated'))

    if (this.inlineState) {
      return Promise.resolve().then(() => {
        const response = handleWordbookRequest(this.inlineState as WordbookWorkerState, request)
        return { ...response, id: 0 }
      })
    }

    const worker = this.worker
    if (!worker) return Promise.reject(new Error('wordbook worker unavailable'))

    const id = this.nextId++
    return new Promise<ResponseEnvelope>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        worker.postMessage({ ...request, id })
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

/** Convenience factory used by screens and tests. */
export function createWordbookWorkerClient(
  options: WordbookWorkerClientOptions = {},
): WordbookWorkerClient {
  return new WordbookWorkerClient(options)
}

type WorkerScope = {
  onmessage: ((event: { data: RequestEnvelope }) => void) | null
  postMessage: (message: unknown) => void
}

/**
 * Install the worker listener only in an actual worker scope.
 *
 * `window` is undefined there; Node/Vitest also lacks `postMessage` on
 * `globalThis`, so importing this module to test the pure handler is harmless.
 */
function installWorkerListener(): void {
  if (typeof window !== 'undefined') return
  const scope = globalThis as unknown as Partial<WorkerScope>
  if (typeof scope.postMessage !== 'function' || typeof scope.onmessage === 'undefined') return

  const state = createWordbookWorkerState()
  const workerScope = scope as WorkerScope
  workerScope.onmessage = (event) => {
    const request = event.data
    try {
      workerScope.postMessage({ ...handleWordbookRequest(state, request), id: request.id })
    } catch (error) {
      workerScope.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
        id: request.id,
      })
    }
  }
}

installWorkerListener()
