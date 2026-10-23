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
 * `handleWordbookRequest` is pure so tests (and the no-Worker fallback) can use
 * the exact same semantics. The module only installs a `message` listener when
 * it is actually running inside a worker.
 */

import type { WordbookEntry } from './buildWordbook'
import {
  compareWordbookEntries,
  computeDocumentProgress,
  type DocumentProgress,
  type ProgressDocument,
  type ProgressEntry,
} from './wordbookProjection'

export type WordbookWorkerRequest =
  | {
      type: 'rebuild'
      entries: readonly WordbookEntry[]
      /** Locale used for sorting; defaults to the runtime locale. */
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
  | { type: 'search'; lemmas: string[]; total: number; id?: number }
  | { type: 'progress'; progress: Record<string, DocumentProgress>; id?: number }
  | { type: 'error'; message: string; id?: number }

type RequestEnvelope = WordbookWorkerRequest & { id?: number }
type ResponseEnvelope = WordbookWorkerResponse & { id?: number }

type IndexEntry = {
  lemma: string
  haystack: string
}

type Dataset = {
  entries: readonly WordbookEntry[]
  index: IndexEntry[]
}

export type WordbookWorkerState = {
  datasets: Map<string, Dataset>
}

export function createWordbookWorkerState(): WordbookWorkerState {
  return { datasets: new Map() }
}

const DEFAULT_LANGUAGE = ''

function indexOf(entries: readonly WordbookEntry[], languageCode: string): IndexEntry[] {
  const index = entries.map((entry) => ({
    lemma: entry.lemma,
    haystack: `${entry.lemma}\n${entry.surfaces.join('\n')}`.toLowerCase(),
  }))
  return index.sort((a, b) => compareWordbookEntries(a, b, languageCode))
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
    })
    return { type: 'rebuilt', total: request.entries.length }
  }

  if (request.type === 'search') {
    const languageCode = request.languageCode ?? DEFAULT_LANGUAGE
    const dataset = state.datasets.get(languageCode)
    if (!dataset) return { type: 'search', lemmas: [], total: 0 }
    const needle = request.query.trim().toLowerCase()
    const lemmas: string[] = []
    for (const item of dataset.index) {
      if (needle !== '' && !item.haystack.includes(needle)) continue
      lemmas.push(item.lemma)
    }
    return { type: 'search', lemmas, total: lemmas.length }
  }

  const rawEntries =
    request.entries ??
    [...state.datasets.values()].flatMap((dataset) => [...dataset.entries])
  let entries = rawEntries as unknown as readonly ProgressEntry[]
  if (request.statuses) {
    const statuses = request.statuses
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
