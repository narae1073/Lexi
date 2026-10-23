/**
 * Projection-backed wordbook read model.
 *
 * The server's `wordbook_entries` rows (stored locally in `wordbookEntries`) are
 * the authoritative source for the wordbook, quiz contexts, and document
 * progress (R3). This module maps those rows to the shape the existing UI already
 * renders, so the UI never scans occurrence rows or trusts the title copied into
 * an occurrence. Titles are resolved from current document metadata instead.
 *
 * Everything expensive — sorting, search matching, and document progress — runs
 * in `wordbookWorker.ts`. The helpers here are the shared, pure implementation:
 * the worker calls them, and so do tests and the no-Worker fallback.
 */

import type { WordbookEntryRecord } from '../../lib/storage/wordbookEntries'
import type { WordState, WordStatus } from '../../types'
import type { WordbookEntry } from './buildWordbook'

/** One stored projection row. Kept as an alias so worker/store boundaries agree. */
export type ProjectionEntry = WordbookEntryRecord

/**
 * A context as the projection carries it.
 *
 * `documentId` is retained on the mapped entry (the visible `WordbookEntry`
 * context drops it because the old occurrence-built model only had the title).
 * Document progress needs the id: a paged document has no occurrence rows on
 * this device, but its projection contexts still say which document a lemma
 * belongs to.
 */
export type ProjectionContext = {
  sentence: string
  documentTitle: string
  documentId: string
}

/**
 * A wordbook row derived from the projection.
 *
 * `contexts` keeps the document id for progress. `documentIds` additionally
 * remembers every document the lemma appeared in, including a document whose
 * only stored sentence was empty (the server does not store empty-sentence
 * contexts, but a local producer or an old row may still carry the id).
 */
export type ProjectionWordbookEntry = Omit<WordbookEntry, 'contexts'> & {
  /** Which language the projection row belongs to (used by progress status overrides). */
  languageCode: string
  contexts: ProjectionContext[]
  documentIds?: string[]
}

/** The document metadata needed to resolve titles (never a stale occurrence title). */
export type DocumentTitleSource = {
  id: string
  title: string
  deletedAt?: string | null
}

/** The slice of progress computation a projection entry must provide. */
export type ProgressEntry = {
  lemma: string
  status: WordStatus | 'unmarked'
  contexts: readonly { documentId?: string }[]
  documentIds?: readonly string[]
  /** Legacy occurrence-built rows carry only the row's chosen document. */
  documentId?: string
}

export type ProgressDocument = {
  id: string
  deletedAt?: string | null
}

/** Which read model a wordbook screen should show right now. */
export type WordbookSource = 'local' | 'projection' | 'preparing'

export type WordbookPresentationInput = {
  /** No account: Task 11 keeps this device's occurrence-built wordbook. */
  localOnly: boolean
  /** Projection is complete for this language and its rows are loaded. */
  projectionReady: boolean
  /** This language's projection pass is paused by the soft byte cap. */
  projectionPaused: boolean
  /** Occurrence rows for this language exist on this device (R2 upgrade). */
  hasLocalWordbook: boolean
}

export type WordbookPresentation = {
  source: WordbookSource
  /** Show the "preparing your wordbook" state (no local wordbook yet). */
  showPreparation: boolean
  /** Show the paused/continue notice. */
  showPaused: boolean
  /** Offer the button that runs the next sync to resume the pass. */
  showContinue: boolean
}

/**
 * Picks the visible wordbook source for an account.
 *
 * R2 upgrade rule: until the first projection pass is complete, the local
 * occurrence-built wordbook stays visible — the device already has it, and an
 * empty screen would look like data loss. A new device has nothing local, so it
 * gets a preparing state instead of an empty list. Once the projection is
 * complete and loaded, the worker-backed projection path takes over.
 */
export function resolveWordbookPresentation({
  localOnly,
  projectionReady,
  projectionPaused,
  hasLocalWordbook,
}: WordbookPresentationInput): WordbookPresentation {
  if (localOnly) {
    return {
      source: 'local',
      showPreparation: false,
      showPaused: false,
      showContinue: false,
    }
  }
  if (projectionReady) {
    return {
      source: 'projection',
      showPreparation: false,
      showPaused: false,
      showContinue: false,
    }
  }
  const source: WordbookSource = hasLocalWordbook ? 'local' : 'preparing'
  return {
    source,
    showPreparation: source === 'preparing',
    showPaused: projectionPaused,
    showContinue: projectionPaused,
  }
}

/** Which row set a wordbook-like screen should render right now. */
export type WordbookRowSource = 'legacy' | 'projection'

export type WordbookRowSourceInput = {
  localOnly: boolean
  /** The source `resolveWordbookPresentation` picked for this screen. */
  presentation: WordbookSource
  /** This language's projection rows are loaded (account or local producer). */
  projectionReady: boolean
  /**
   * The worker has answered at least one search for this language.
   *
   * Local-only rows reach the screen through the worker's sorted lemmas, so the
   * first render after the producer loads would otherwise be an empty list for
   * one frame. Keeping the occurrence-built list until the first answer avoids
   * that flash — and only the first one: later searches keep the previous
   * ordering on screen while they run.
   */
  sortedReady: boolean
}

/**
 * Picks rows for a wordbook screen.
 *
 * Account mode keeps Task 10's rule (local occurrences during the R2 upgrade,
 * the projection once complete). Local-only mode uses the same projection rows
 * once the producer has built and indexed them; until then the occurrence-built
 * list stays visible, exactly as before Task 11.
 */
export function resolveWordbookRowSource({
  localOnly,
  presentation,
  projectionReady,
  sortedReady,
}: WordbookRowSourceInput): WordbookRowSource {
  if (localOnly) return projectionReady && sortedReady ? 'projection' : 'legacy'
  return presentation === 'local' ? 'legacy' : 'projection'
}

/** "N of M languages ready" progress for the preparing state. */export function preparationProgress(
  completeByLanguage: Readonly<Record<string, boolean>>,
  languages: readonly string[],
): { ready: number; total: number; percent: number } {
  const total = languages.length
  const ready = languages.filter((language) => completeByLanguage[language] === true).length
  return {
    ready,
    total,
    percent: total === 0 ? 0 : Math.round((ready / total) * 100),
  }
}

/** Same shape as `documentProgress.DocumentProgress` but kept here for the worker. */
export type DocumentProgress = {
  total: number
  marked: number
  percent: number
}

export type ProjectionMapOptions = {
  /** Current documents — titles come from here, not from the projection row. */
  documents?: readonly DocumentTitleSource[]
  /** Optional prebuilt title map (avoids rebuilding it per row). */
  documentTitles?: ReadonlyMap<string, string>
  /**
   * Local word states overlay the projection. A dirty local edit wins until the
   * projection pull catches up, exactly as the sync merge rule says.
   */
  stateOf?: (lemma: string) => WordState | undefined
}

function titleMap(options: ProjectionMapOptions): ReadonlyMap<string, string> {
  if (options.documentTitles) return options.documentTitles
  const titles = new Map<string, string>()
  for (const doc of options.documents ?? []) titles.set(doc.id, doc.title)
  return titles
}

function normalizeStatus(status: WordStatus | null | undefined): WordStatus | 'unmarked' {
  return status ?? 'unmarked'
}

function overlayState(
  entry: ProjectionEntry,
  state: WordState | undefined,
  titles: ReadonlyMap<string, string>,
): ProjectionWordbookEntry {
  // Keep every document association, even when the sentence was empty, so a
  // document progress gauge never loses a word it can otherwise see.
  const documentIds = [...new Set(entry.contexts.map((context) => context.documentId))]

  const contexts: ProjectionContext[] = []
  const seen = new Set<string>()
  for (const context of entry.contexts) {
    // Empty sentences are not contexts for display or the quiz — the same rule
    // as buildWordbook and the server aggregation.
    if (context.sentence === '') continue
    const key = `${context.documentId}\u0000${context.sentence}`
    if (seen.has(key)) continue
    seen.add(key)
    contexts.push({
      sentence: context.sentence,
      documentTitle: titles.get(context.documentId) ?? '',
      documentId: context.documentId,
    })
  }

  // Prefer a real context for the row's example sentence. If every context was
  // empty, the row still belongs to its first document — the sentence is empty,
  // but the title and id are knowledge we have. (This keeps the row identical
  // to buildWordbook's behavior for an empty-sentence occurrence.)
  const source = contexts[0] ?? entry.contexts[0]
  const chosen = contexts[0]

  // A local word state exists only for a word this device has touched. When it
  // exists it is newer than the projection row for this key (the merge guard
  // skipped the key), so its fields win.
  const status = state ? normalizeStatus(state.status) : normalizeStatus(entry.status)
  const favorite = state ? state.favorite : entry.isFavorite
  const starColor = state ? state.starColor : entry.starColor
  const lastSeenAt = state ? state.lastSeenAt : (entry.lastSeenAt ?? '')
  const knownPresses = state ? state.knownPresses : entry.knownPresses
  const note = state ? state.note : (entry.note ?? undefined)

  return {
    languageCode: entry.languageCode,
    lemma: entry.lemma,
    surfaces: [...entry.surfaces],
    status,
    favorite,
    starColor,
    sentence: chosen?.sentence ?? '',
    documentId: source?.documentId ?? '',
    documentTitle: source ? (titles.get(source.documentId) ?? '') : '',
    contexts,
    documentIds,
    lastSeenAt,
    knownPresses,
    note,
    count: entry.occurrenceCount,
    documentCount: entry.documentCount,
  }
}

/**
 * One projection row → the wordbook row the UI renders.
 *
 * Titles are looked up from current documents; a missing document yields an
 * empty title, never the title copied into a stale occurrence.
 */
export function projectionEntryToWordbook(
  entry: ProjectionEntry,
  options: ProjectionMapOptions = {},
): ProjectionWordbookEntry {
  const titles = titleMap(options)
  return overlayState(entry, options.stateOf?.(entry.lemma), titles)
}

/** Batch form — builds the title map once for a language. */
export function projectionEntriesToWordbook(
  entries: readonly ProjectionEntry[],
  options: ProjectionMapOptions = {},
): ProjectionWordbookEntry[] {
  const titles = titleMap(options)
  return entries.map((entry) => overlayState(entry, options.stateOf?.(entry.lemma), titles))
}

/** True when a lemma or any of its surfaces contains the query (case-insensitive). */
export function matchesWordbookQuery(
  entry: Pick<WordbookEntry, 'lemma' | 'surfaces'>,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  if (entry.lemma.toLowerCase().includes(needle)) return true
  return entry.surfaces.some((surface) => surface.toLowerCase().includes(needle))
}

/** Locale-aware comparison with a deterministic tie-break for case variants. */
export function compareWordbookEntries(
  a: Pick<WordbookEntry, 'lemma'>,
  b: Pick<WordbookEntry, 'lemma'>,
  languageCode: string,
): number {
  let compared: number
  try {
    compared = a.lemma.localeCompare(b.lemma, languageCode, { sensitivity: 'base' })
  } catch {
    // A malformed language tag must not make the wordbook unsortable.
    compared = 0
  }
  if (compared !== 0) return compared
  return a.lemma < b.lemma ? -1 : a.lemma > b.lemma ? 1 : 0
}

/** Sorted copy — never mutates the input. */
export function sortWordbookEntries<T extends Pick<WordbookEntry, 'lemma'>>(
  entries: readonly T[],
  languageCode: string,
): T[] {
  return [...entries].sort((a, b) => compareWordbookEntries(a, b, languageCode))
}

/** Filter + sort. The worker keeps a compact index and uses the matcher directly. */
export function searchProjectionEntries<T extends Pick<WordbookEntry, 'lemma' | 'surfaces'>>(
  entries: readonly T[],
  query: string,
  languageCode = 'en',
): T[] {
  const needle = query.trim().toLowerCase()
  const matches =
    needle === ''
      ? [...entries]
      : entries.filter((entry) => matchesWordbookQuery(entry, needle))
  return sortWordbookEntries(matches, languageCode)
}

/**
 * Per-document progress from projection contexts.
 *
 * A document's total is the number of distinct lemmas whose projection entry
 * mentions it; marked counts those with any stored status. A shared lemma counts
 * once in each document, and duplicate contexts for the same document do not
 * inflate the total. Paged documents work because the projection carries the
 * document id even when no occurrence rows were downloaded.
 *
 * When `documents` is supplied, contexts for documents that are not live
 * (deleted or unknown) are ignored — the list cannot show their gauges anyway.
 */
export function computeDocumentProgress(
  entries: readonly ProgressEntry[],
  documents?: readonly ProgressDocument[],
  statusOf?: (entry: ProgressEntry) => ProgressEntry['status'],
): Map<string, DocumentProgress> {
  if (documents) return computeProgressForDocuments(entries, documents, statusOf)

  const byDocument = new Map<string, Map<string, boolean>>()
  /**
   * One shared de-duplication table instead of a Set per entry.
   *
   * Every entry can carry the same document several times (one context per
   * sentence), and a 200k fixture has tens of thousands of entries. Allocating
   * a Set for each one was measurable in the document-progress round trip; the
   * stamp is the entry's position, so a document is visited once per entry.
   */
  const seenAt = new Map<string, number>()

  entries.forEach((entry, entryIndex) => {
    const marked = (statusOf ? statusOf(entry) : entry.status) !== 'unmarked'
    const visit = (id: string | undefined) => {
      if (!id || seenAt.get(id) === entryIndex) return
      seenAt.set(id, entryIndex)
      let lemmas = byDocument.get(id)
      if (!lemmas) {
        lemmas = new Map()
        byDocument.set(id, lemmas)
      }
      // A lemma is one word per document even when it has many contexts there.
      if (!lemmas.has(entry.lemma)) lemmas.set(entry.lemma, marked)
    }

    visitEntryDocuments(entry, visit)
  })

  const progress = new Map<string, DocumentProgress>()
  for (const [documentId, lemmas] of byDocument) {
    progress.set(documentId, summarizeLemmas(lemmas))
  }
  return progress
}

/** Visits each distinct document association of one entry. */
export function visitEntryDocuments(
  entry: ProgressEntry,
  visit: (documentId: string | undefined) => void,
): void {
  if (entry.documentIds && entry.documentIds.some((id) => id !== undefined)) {
    for (const id of entry.documentIds) visit(id)
    return
  }
  if (entry.documentIds) {
    // An explicitly empty association list is not evidence for contexts;
    // the legacy single-document field is the only fallback.
    if (entry.documentId) visit(entry.documentId)
    return
  }
  let hadContextId = false
  for (const context of entry.contexts) {
    if (context.documentId) hadContextId = true
    visit(context.documentId)
  }
  if (!hadContextId && entry.documentId) visit(entry.documentId)
}

function summarizeLemmas(lemmas: Map<string, boolean>): DocumentProgress {
  let marked = 0
  for (const isMarked of lemmas.values()) if (isMarked) marked += 1
  const total = lemmas.size
  return { total, marked, percent: total === 0 ? 0 : Math.round((marked / total) * 100) }
}

/**
 * The path DocumentList uses: the caller already knows every live document.
 *
 * Documents become integer slots, so each visited context costs one map lookup
 * and an array read instead of two nested string-keyed map lookups. This is
 * what keeps the 200k fixture's progress computation under the 100 ms budget.
 */
function computeProgressForDocuments(
  entries: readonly ProgressEntry[],
  documents: readonly ProgressDocument[],
  statusOf?: (entry: ProgressEntry) => ProgressEntry['status'],
): Map<string, DocumentProgress> {
  const live = documents.filter((doc) => !doc.deletedAt)
  const indexById = new Map<string, number>()
  live.forEach((doc, index) => indexById.set(doc.id, index))

  const lastEntry = new Int32Array(live.length).fill(-1)
  const lemmasByDocument: Array<Map<string, boolean> | undefined> = new Array(live.length)

  entries.forEach((entry, entryIndex) => {
    const marked = (statusOf ? statusOf(entry) : entry.status) !== 'unmarked'
    const visit = (id: string | undefined) => {
      if (!id) return
      const index = indexById.get(id)
      if (index === undefined || lastEntry[index] === entryIndex) return
      lastEntry[index] = entryIndex
      let lemmas = lemmasByDocument[index]
      if (!lemmas) {
        lemmas = new Map()
        lemmasByDocument[index] = lemmas
      }
      if (!lemmas.has(entry.lemma)) lemmas.set(entry.lemma, marked)
    }
    visitEntryDocuments(entry, visit)
  })

  const progress = new Map<string, DocumentProgress>()
  for (let index = 0; index < live.length; index += 1) {
    const lemmas = lemmasByDocument[index]
    if (lemmas) progress.set(live[index].id, summarizeLemmas(lemmas))
  }
  return progress
}

/**
 * Restricts a row to one document's context — the wordbook's `?doc=` scope.
 *
 * Counts stay the projection's totals: the projection does not carry per-document
 * occurrence counts, and inventing one would be a different number from the
 * main wordbook row. The context (and therefore the example sentence/title) does
 * follow the scope.
 */
export function scopeProjectionEntry(
  entry: ProjectionWordbookEntry,
  documentId: string,
): ProjectionWordbookEntry | null {
  if (!entry.documentIds?.includes(documentId)) {
    const context = entry.contexts.find((item) => item.documentId === documentId)
    if (!context) return null
  }
  const context = entry.contexts.find((item) => item.documentId === documentId)
  return {
    ...entry,
    sentence: context?.sentence ?? '',
    documentId,
    documentTitle: context?.documentTitle ?? '',
  }
}
