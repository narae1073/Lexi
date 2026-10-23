/**
 * Local-only wordbook projection (Task 11).
 *
 * Account mode reads `wordbook_entries`, a server-owned projection of the
 * occurrences and word states. A device without an account has no server, so it
 * has to build the same read model itself. This module is that producer:
 *
 *   - {@link buildLocalProjection} is the pure builder. It applies the same
 *     semantic rules as `buildWordbook` (one row per lemma, counts summed over
 *     documents, empty sentences excluded from the quiz contexts) and writes
 *     the Task 10 projection shape (`wordbookEntries`), not a UI-specific one.
 *     The worker calls it, and so do tests.
 *   - {@link LocalProjectionProducer} keeps the stored projection current. It
 *     runs the expensive build in the worker, persists the rows with the same
 *     storage API a projection pull uses, and tells the wordbook store which
 *     rows changed.
 *   - {@link onLocalProjectionChange} is the trigger bus. The occurrence and
 *     word-state stores announce what changed (one document, one lemma, one
 *     language); the producer turns that into the smallest rebuild it can.
 *
 * Nothing here talks to the network. Local-only mode never calls a projection
 * RPC — there is no account to project from.
 */

import type { WordOccurrence } from '../../app/stores/occurrences'
import type { WordStatus } from '../../types'
import {
  clearWordbookEntries,
  deleteWordbookEntry,
  putWordbookEntries,
  type WordbookEntryInput,
} from '../../lib/storage/wordbookEntries'
import { STORES, idbGet, idbGetAllByIndex } from '../../lib/storage/localDb'
import type { ProjectionEntry } from './wordbookProjection'
import { createWordbookWorkerClient, type WordbookWorkerClient } from './wordbookWorker'

/**
 * The star colour the server coalesces to when a word state has none.
 *
 * Duplicated from the settings store on purpose: the worker imports the builder,
 * and the settings store persists through `localStorage`, which a worker scope
 * does not have. Importing it here would make the worker bundle crash on load.
 */
const LOCAL_STAR_COLOR_DEFAULT = '#eab308'

/**
 * A word state as the local producer reads it.
 *
 * Looser than `WordState` because rows in `wordStates` are `StoredWordState`:
 * `favoriteUpdatedAt` and the star/press fields are optional on rows written by
 * older builds. Every missing field falls back to the same default the server's
 * `coalesce(...)` uses.
 */
export type LocalWordState = {
  lemma: string
  languageCode: string
  status?: WordStatus
  seenCount?: number
  firstSeenAt?: string
  lastSeenAt?: string
  favorite?: boolean
  favoriteUpdatedAt?: string
  starAngle?: number
  starColor?: string
  knownPresses?: number
  unsurePresses?: number
  unknownPresses?: number
  note?: string
  noteUpdatedAt?: string
}

export type LocalWordStates =
  | readonly LocalWordState[]
  | Readonly<Record<string, LocalWordState>>

/** The visible marker a row gets when no word state exists for it. */
type StatusValue = WordStatus | null

function stateKey(languageCode: string, lemma: string): string {
  return `${languageCode}::${lemma}`
}

/** Normalizes either input form into one lookup by `${languageCode}::${lemma}`. */
function stateLookup(wordStates: LocalWordStates): Map<string, LocalWordState> {
  const lookup = new Map<string, LocalWordState>()
  if (Array.isArray(wordStates)) {
    for (const state of wordStates as readonly LocalWordState[]) {
      lookup.set(stateKey(state.languageCode, state.lemma), state)
    }
    return lookup
  }
  for (const state of Object.values(wordStates as Readonly<Record<string, LocalWordState>>)) {
    if (!state) continue
    lookup.set(stateKey(state.languageCode, state.lemma), state)
  }
  return lookup
}

type LemmaGroup = {
  languageCode: string
  lemma: string
  occurrences: WordOccurrence[]
}

/**
 * One lemma's projection row.
 *
 * Contexts and surfaces are ordered exactly like the server's aggregation
 * (`wordbook_refresh.sql`): contexts by `(documentId, sentence)` and surfaces
 * alphabetically. The read model takes `contexts[0]` as the row's example, so a
 * local-only device must pick the same document an account would — not the most
 * recently recorded one. (The legacy `buildWordbook` picks recency; that
 * difference is intentional and is what Task 10's projection path replaced.)
 *
 * Empty sentences are not display contexts (the quiz must not show an empty
 * example), but a document whose only sentence is empty still keeps one empty
 * context: the read model reads document associations from contexts, and losing
 * it would drop the word from that document's progress gauge.
 */
function projectLemma(group: LemmaGroup, state: LocalWordState | undefined): ProjectionEntry {
  const rows = group.occurrences
  const surfaceSet = new Set<string>()
  const documents = new Set<string>()
  const withSentence = new Set<string>()
  let count = 0

  for (const row of rows) {
    count += row.count
    documents.add(row.documentId)
    for (const surface of row.surfaces) surfaceSet.add(surface)
    if (row.sentence !== '') withSentence.add(row.documentId)
  }

  // The server keeps one context per (document, sentence) where the sentence is
  // not blank. Add the empty-only documents afterwards so their ids survive for
  // progress without pretending they have a usable example.
  const contexts: { documentId: string; sentence: string }[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (row.sentence === '') continue
    const key = `${row.documentId}\u0000${row.sentence}`
    if (seen.has(key)) continue
    seen.add(key)
    contexts.push({ documentId: row.documentId, sentence: row.sentence })
  }
  for (const row of rows) {
    if (row.sentence !== '' || withSentence.has(row.documentId)) continue
    const key = `${row.documentId}\u0000`
    if (seen.has(key)) continue
    seen.add(key)
    contexts.push({ documentId: row.documentId, sentence: '' })
  }
  contexts.sort(compareContexts)

  const status: StatusValue = state?.status ?? null
  return {
    languageCode: group.languageCode,
    lemma: group.lemma,
    surfaces: [...surfaceSet].sort(),
    contexts,
    occurrenceCount: count,
    documentCount: documents.size,
    status,
    isFavorite: state?.favorite ?? false,
    starAngle: state?.starAngle ?? 0,
    starColor: state?.starColor ?? LOCAL_STAR_COLOR_DEFAULT,
    seenCount: state?.seenCount ?? 1,
    firstSeenAt: state?.firstSeenAt ?? null,
    lastSeenAt: state?.lastSeenAt ?? null,
    favoriteUpdatedAt: state?.favoriteUpdatedAt ?? null,
    knownPresses: state?.knownPresses ?? 0,
    unsurePresses: state?.unsurePresses ?? 0,
    unknownPresses: state?.unknownPresses ?? 0,
    note: state?.note ?? null,
    noteUpdatedAt: state?.noteUpdatedAt ?? null,
    // A local row has no server watermark. It is not a projection pull result,
    // and nothing merges it with one.
    serverUpdatedAt: null,
  }
}

/** Server order for projection contexts: `order by document_id, sentence`. */
function compareContexts(
  a: { documentId: string; sentence: string },
  b: { documentId: string; sentence: string },
): number {
  if (a.documentId !== b.documentId) return a.documentId < b.documentId ? -1 : 1
  if (a.sentence === b.sentence) return 0
  return a.sentence < b.sentence ? -1 : 1
}

/** Deterministic projection order — the UI sorts again in the worker. */
function compareProjectionKeys(a: ProjectionEntry, b: ProjectionEntry): number {
  if (a.languageCode !== b.languageCode) return a.languageCode < b.languageCode ? -1 : 1
  if (a.lemma === b.lemma) return 0
  return a.lemma < b.lemma ? -1 : 1
}

/**
 * Builds the local wordbook projection from this device's own rows.
 *
 * A lemma with a word state but no occurrence is not projected: the state is not
 * evidence that the word appears anywhere, and the server's aggregation never
 * inserts such a row either. A lemma is keyed by `(languageCode, lemma)` — the
 * only identity the projection uses.
 *
 * Titles are deliberately not part of the row. The Task 10 read model resolves a
 * context's title from current document metadata by id, which is what keeps a
 * renamed document from showing its old name; storing a title here would reopen
 * exactly the stale-title bug that change closed.
 */
export function buildLocalProjection(
  occurrences: readonly WordOccurrence[],
  wordStates: LocalWordStates,
): ProjectionEntry[] {
  const states = stateLookup(wordStates)
  const groups = new Map<string, LemmaGroup>()

  for (const occurrence of occurrences) {
    const key = `${occurrence.languageCode}\u0000${occurrence.lemma}`
    const group = groups.get(key)
    if (group) {
      group.occurrences.push(occurrence)
      continue
    }
    groups.set(key, {
      languageCode: occurrence.languageCode,
      lemma: occurrence.lemma,
      occurrences: [occurrence],
    })
  }

  const entries: ProjectionEntry[] = []
  for (const group of groups.values()) {
    const state = states.get(stateKey(group.languageCode, group.lemma))
    entries.push(projectLemma(group, state))
  }
  return entries.sort(compareProjectionKeys)
}

/* ------------------------------------------------------------------------- *
 * Change bus
 * ------------------------------------------------------------------------- */

/**
 * What a local store changed.
 *
 * `state` updates patch exactly one row; `document` updates recompute exactly
 * the lemmas of one document. The stores send the smallest fact they have so
 * the producer never scans a 200k-row list to find out what moved.
 */
export type LocalProjectionChange =
  | { type: 'language'; languageCode: string }
  | { type: 'document'; languageCode: string; documentId: string }
  | { type: 'documents-removed'; languageCode: string; documentIds: readonly string[] }
  | { type: 'state'; languageCode: string; lemma: string; state: LocalWordState }

type LocalProjectionListener = (change: LocalProjectionChange) => void

const listeners = new Set<LocalProjectionListener>()

/** Subscribes to local changes. Returns the unsubscribe function. */
export function onLocalProjectionChange(listener: LocalProjectionListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Announces a local change.
 *
 * A failing listener must never break the write that already committed, so each
 * listener is isolated. With no local-only producer subscribed this is a no-op.
 */
export function notifyLocalProjectionChange(change: LocalProjectionChange): void {
  for (const listener of listeners) {
    try {
      listener(change)
    } catch (error) {
      console.error('로컬 단어장 갱신 알림 실패', error)
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Producer
 * ------------------------------------------------------------------------- */

/** One local build as the worker reports it. */
export type LocalProjectionBuild = {
  /** Rows that changed — every row on a full rebuild, only the affected ones otherwise. */
  entries: ProjectionEntry[]
  /** Lemmas that no longer have any occurrence and must be removed. */
  removed: string[]
  /** Rows this language has after the build. */
  total: number
  /** True when every row was recomputed (initial build or an explicit rebuild). */
  full: boolean
}

/** What the producer sends to the worker. */
export type LocalProjectionRequest = {
  /** Occurrences of `documentIds`, or every occurrence of the language on a full rebuild. */
  occurrences: readonly WordOccurrence[]
  /** Word states to merge; a complete set on a full rebuild. */
  wordStates?: readonly LocalWordState[]
  /** Changed documents. Omitted together with the removals means a full rebuild. */
  documentIds?: readonly string[]
  /** Documents that no longer exist in this language. */
  removedDocumentIds?: readonly string[]
}

/** The slice of the worker client the producer needs. Tests pass a fake. */
export type LocalProjectionWorker = {
  localRebuild: (
    languageCode: string,
    request: LocalProjectionRequest,
  ) => Promise<LocalProjectionBuild>
  /** Releases the worker's local source/index. Missing on minimal test fakes. */
  localClear?: (languageCode?: string) => Promise<void>
}

/** Where produced rows go for display. */
export type LocalProjectionSink = {
  /** Replaces one language's rows (initial build). */
  setEntries: (languageCode: string, entries: ProjectionEntry[]) => void
  /** Patches the rows that changed, leaving every other row untouched. */
  applyEntries: (
    languageCode: string,
    entries: ProjectionEntry[],
    removedLemmas: readonly string[],
  ) => void
}

export type LocalProjectionProducerOptions = {
  /** Injection point for tests. Defaults to the shared wordbook worker client. */
  worker?: LocalProjectionWorker
  /** Defaults to the `wordOccurrences` language index. */
  readOccurrences?: (languageCode: string) => Promise<WordOccurrence[]>
  /** Defaults to the `wordOccurrences` document index. */
  readDocumentOccurrences?: (documentId: string) => Promise<WordOccurrence[]>
  /** Defaults to the `wordStates` language index. */
  readWordStates?: (languageCode: string) => Promise<LocalWordState[]>
  putEntries?: (rows: readonly WordbookEntryInput[]) => Promise<unknown>
  deleteEntry?: (languageCode: string, lemma: string) => Promise<void>
  clearEntries?: (languageCode: string) => Promise<void>
  /** Omit to only persist (tests); the app wires this to the wordbook store. */
  sink?: LocalProjectionSink
}

/**
 * Rows per storage transaction.
 *
 * A 200k-word device has over 100k projection rows. One transaction of that size
 * keeps a long-lived write lock and can fail as a unit; small batches keep the
 * database responsive. A partially written language is repaired by the next
 * rebuild, which always starts by clearing.
 */
const LOCAL_WRITE_BATCH = 1_000

function chunkRows<T>(rows: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size))
  }
  return chunks
}

let sharedWorker: WordbookWorkerClient | null = null

/** The worker client local-only search and the producer share. */
function defaultWorker(): WordbookWorkerClient {
  if (!sharedWorker) sharedWorker = createWordbookWorkerClient()
  return sharedWorker
}

/**
 * Searches the local projection in the worker.
 *
 * The worker keeps the language's sorted lemma index after a local build, so the
 * wordbook screen can use the same search boundary as account mode without
 * sending 116k rows anywhere.
 */
export function searchLocalProjection(query: string, languageCode: string): Promise<string[]> {
  return defaultWorker().search(query, languageCode)
}

/** Terminates the shared local worker (tests and full app teardown). */
export function disposeLocalProjectionWorker(): void {
  sharedWorker?.terminate()
  sharedWorker = null
}

/**
 * Releases the shared worker's local datasets without tearing the worker down.
 *
 * Sent when this device links an account: the account projection uses a
 * different worker client for search, and the local-only source rows would
 * otherwise stay in memory (a 200k-occurrence language plus its index).
 * Resolves immediately when no local worker was ever created.
 */
export function releaseLocalProjectionWorker(): Promise<void> {
  const worker = sharedWorker
  if (!worker) return Promise.resolve()
  return worker.localClear()
}

/** One row's state fields, in the projection's terms. */
function stateFields(state: LocalWordState): Partial<WordbookEntryInput> {
  return {
    status: state.status ?? null,
    isFavorite: state.favorite ?? false,
    starAngle: state.starAngle ?? 0,
    starColor: state.starColor ?? LOCAL_STAR_COLOR_DEFAULT,
    seenCount: state.seenCount ?? 1,
    firstSeenAt: state.firstSeenAt ?? null,
    lastSeenAt: state.lastSeenAt ?? null,
    favoriteUpdatedAt: state.favoriteUpdatedAt ?? null,
    knownPresses: state.knownPresses ?? 0,
    unsurePresses: state.unsurePresses ?? 0,
    unknownPresses: state.unknownPresses ?? 0,
    note: state.note ?? null,
    noteUpdatedAt: state.noteUpdatedAt ?? null,
  }
}

/**
 * Keeps `wordbookEntries` current for one local-only device.
 *
 * All work for a language is serialized through one promise chain. Two rebuilds
 * of the same language would race their worker responses and could write an
 * older row after a newer one — the same reason the server refreshes a lemma set
 * in one ordered statement.
 *
 * A generation token fences `reset()`. A build that started before the device
 * linked an account must not clear, write, or mark itself built afterwards: its
 * rows are local-derived and would land inside the account projection.
 */
export class LocalProjectionProducer {
  private readonly options: LocalProjectionProducerOptions
  private readonly built = new Set<string>()
  private readonly chains = new Map<string, Promise<unknown>>()
  /** Incremented by `reset()`/`dispose()`; every build checks it before writing. */
  private generation = 0
  private disposed = false

  constructor(options: LocalProjectionProducerOptions = {}) {
    this.options = options
  }

  /** Builds a language once. Safe to call from every startup path. */
  ensureLanguage(languageCode: string): Promise<void> {
    if (this.disposed || this.built.has(languageCode)) return Promise.resolve()
    return this.enqueue(languageCode, (generation) =>
      // The check is repeated inside the queue: a second caller may have queued
      // this before the first build finished.
      this.built.has(languageCode)
        ? Promise.resolve()
        : this.buildLanguage(languageCode, generation),
    )
  }

  /** Recomputes every row of a language (startup, lemma-version change). */
  rebuildLanguage(languageCode: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    return this.enqueue(languageCode, (generation) =>
      this.buildLanguage(languageCode, generation),
    )
  }

  /** Recomputes only the lemmas of one recorded document. */
  updateDocument(languageCode: string, documentId: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    return this.enqueue(languageCode, async (generation) => {
      if (!this.built.has(languageCode)) return this.buildLanguage(languageCode, generation)
      const rows = await this.readDocumentOccurrences(documentId)
      if (!this.current(generation)) return
      const result = await this.worker.localRebuild(languageCode, {
        occurrences: rows.filter((row) => row.languageCode === languageCode),
        documentIds: [documentId],
      })
      await this.apply(languageCode, result, generation)
    })
  }

  /** Drops every lemma of the removed documents; shared lemmas keep their other rows. */
  removeDocuments(languageCode: string, documentIds: readonly string[]): Promise<void> {
    if (this.disposed || documentIds.length === 0) return Promise.resolve()
    return this.enqueue(languageCode, async (generation) => {
      if (!this.built.has(languageCode)) return this.buildLanguage(languageCode, generation)
      const result = await this.worker.localRebuild(languageCode, {
        occurrences: [],
        removedDocumentIds: [...documentIds],
      })
      await this.apply(languageCode, result, generation)
    })
  }

  /**
   * Patches one row's state fields.
   *
   * A word state without an occurrence is not part of the projection, so a row
   * that does not exist is left alone. The visible overlay in the wordbook store
   * is already updated synchronously by the word-state subscription; this keeps
   * the persisted row from falling behind it.
   */
  updateState(languageCode: string, lemma: string, state: LocalWordState): Promise<void> {
    if (this.disposed) return Promise.resolve()
    return this.enqueue(languageCode, async (generation) => {
      // A state edit can arrive before the first build. Build first, then patch:
      // the build already picks the state up from storage, and patching after it
      // also covers a state write that had not committed when the build read.
      if (!this.built.has(languageCode)) {
        await this.buildLanguage(languageCode, generation)
        if (!this.current(generation)) return
      }
      const stored = await idbGet<WordbookEntryInput>(STORES.wordbookEntries, [
        languageCode,
        lemma,
      ])
      if (!stored || !this.current(generation)) return
      const next: WordbookEntryInput = { ...stored, ...stateFields(state) }
      // `WordState` does not carry the star watermark, so a state edit must not
      // blank the one already stored on the row.
      if (state.favoriteUpdatedAt === undefined) {
        next.favoriteUpdatedAt = stored.favoriteUpdatedAt ?? null
      }
      await this.putEntries([next])
      if (!this.current(generation)) return
      // Keep the worker's copy in step so a later rebuild of this lemma (a
      // document edit) does not project an older status.
      void this.worker
        .localRebuild(languageCode, {
          occurrences: [],
          documentIds: [],
          wordStates: [state],
        })
        .catch((error) => console.error('로컬 단어장 상태 반영 실패', error))
    })
  }

  /**
   * Applies a change from {@link onLocalProjectionChange}.
   *
   * Errors stay in this producer (a listener must not break the store write that
   * already committed). The returned promise lets tests and teardown await it.
   */
  handle(change: LocalProjectionChange): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const task = ((): Promise<void> => {
      switch (change.type) {
        case 'language':
          return this.ensureLanguage(change.languageCode)
        case 'document':
          return this.updateDocument(change.languageCode, change.documentId)
        case 'documents-removed':
          return this.removeDocuments(change.languageCode, change.documentIds)
        case 'state':
          return this.updateState(change.languageCode, change.lemma, change.state)
      }
    })()
    return task.catch((error) => {
      console.error('로컬 단어장 갱신 실패', error)
    })
  }

  /**
   * Forgets which languages were built and fences any in-flight work.
   *
   * Used when the device leaves local-only mode. The generation bump makes a
   * running build abandon its clear/write path, and the worker releases the
   * local source rows and index. A later return to local-only starts from this
   * device's rows again instead of trusting account projection rows.
   */
  async reset(): Promise<void> {
    this.generation += 1
    this.built.clear()
    // Do not make later tasks wait behind a build that is now fence-blocked.
    this.chains.clear()
    const injected = this.options.worker
    if (injected) {
      if (injected.localClear) {
        await injected.localClear().catch(() => undefined)
      }
      return
    }
    await releaseLocalProjectionWorker().catch((error) => {
      console.error('로컬 단어장 정리 실패', error)
    })
  }

  /** Waits for every language's queued work (tests and shutdown). */
  async flush(): Promise<void> {
    await Promise.all([...this.chains.values()].map((chain) => chain.catch(() => undefined)))
  }

  /** Stops accepting work, releases local data, and terminates an owned worker. */
  dispose(): void {
    this.generation += 1
    this.disposed = true
    this.chains.clear()
    this.built.clear()
    const injected = this.options.worker
    if (injected) {
      void injected.localClear?.().catch(() => undefined)
      return
    }
    disposeLocalProjectionWorker()
  }

  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation
  }

  private get worker(): LocalProjectionWorker {
    return this.options.worker ?? defaultWorker()
  }

  private enqueue(
    languageCode: string,
    task: (generation: number) => Promise<void>,
  ): Promise<void> {
    const generation = this.generation
    const previous = this.chains.get(languageCode) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => (this.current(generation) ? task(generation) : undefined))
    this.chains.set(languageCode, next)
    return next
  }

  private async buildLanguage(languageCode: string, generation: number): Promise<void> {
    const [occurrences, wordStates] = await Promise.all([
      this.readOccurrences(languageCode),
      this.readWordStates(languageCode),
    ])
    if (!this.current(generation)) return
    const result = await this.worker.localRebuild(languageCode, { occurrences, wordStates })
    if (!this.current(generation)) return
    // Clear first: the build is the whole truth for the language, and a row left
    // over from an older projection would otherwise survive as a phantom.
    await this.clearEntries(languageCode)
    for (const chunk of chunkRows(result.entries, LOCAL_WRITE_BATCH)) {
      if (!this.current(generation)) return
      await this.putEntries(chunk)
    }
    if (!this.current(generation)) return
    this.options.sink?.setEntries(languageCode, result.entries)
    this.built.add(languageCode)
  }

  private async apply(
    languageCode: string,
    result: LocalProjectionBuild,
    generation: number,
  ): Promise<void> {
    for (const lemma of result.removed) {
      if (!this.current(generation)) return
      await this.deleteEntry(languageCode, lemma)
    }
    for (const chunk of chunkRows(result.entries, LOCAL_WRITE_BATCH)) {
      if (!this.current(generation)) return
      await this.putEntries(chunk)
    }
    if (!this.current(generation)) return
    if (result.entries.length > 0 || result.removed.length > 0) {
      this.options.sink?.applyEntries(languageCode, result.entries, result.removed)
    }
  }

  private readOccurrences(languageCode: string): Promise<WordOccurrence[]> {
    if (this.options.readOccurrences) return this.options.readOccurrences(languageCode)
    return idbGetAllByIndex<WordOccurrence>(
      STORES.wordOccurrences,
      'languageCode',
      languageCode,
    )
  }

  private readDocumentOccurrences(documentId: string): Promise<WordOccurrence[]> {
    if (this.options.readDocumentOccurrences) {
      return this.options.readDocumentOccurrences(documentId)
    }
    return idbGetAllByIndex<WordOccurrence>(STORES.wordOccurrences, 'documentId', documentId)
  }

  private readWordStates(languageCode: string): Promise<LocalWordState[]> {
    if (this.options.readWordStates) return this.options.readWordStates(languageCode)
    return idbGetAllByIndex<LocalWordState>(STORES.wordStates, 'languageCode', languageCode)
  }

  private putEntries(rows: readonly WordbookEntryInput[]): Promise<unknown> {
    if (this.options.putEntries) return this.options.putEntries(rows)
    return putWordbookEntries(rows)
  }

  private deleteEntry(languageCode: string, lemma: string): Promise<void> {
    if (this.options.deleteEntry) return this.options.deleteEntry(languageCode, lemma)
    return deleteWordbookEntry(languageCode, lemma)
  }

  private clearEntries(languageCode: string): Promise<void> {
    if (this.options.clearEntries) return this.options.clearEntries(languageCode)
    return clearWordbookEntries(languageCode)
  }
}

/** Convenience factory used by the app and tests. */
export function createLocalProjectionProducer(
  options: LocalProjectionProducerOptions = {},
): LocalProjectionProducer {
  return new LocalProjectionProducer(options)
}
