/**
 * Wordbook read-model store (R3).
 *
 * The UI reads projection rows (`wordbookEntries`) through here. The projection
 * is server-owned; this store is only the device copy plus the local word-state
 * overlay that makes a status tap visible immediately.
 *
 * Two invariants matter for scale:
 *
 * - A projection refresh maps a whole language once. Nothing here scans
 *   occurrence rows.
 * - A word-state edit patches only the affected entry (and clones the array
 *   once). It never remaps or re-sorts 116k rows, which is what keeps a status
 *   update under the interaction budget.
 */

import { create } from 'zustand'

import { STORES, idbGetAll } from '../../lib/storage/localDb'
import { readProjectionState, type ProjectionPause } from '../../lib/sync/projectionState'
import { readWordbookEntries } from '../../lib/storage/wordbookEntries'
import type { WordState } from '../../types'
import {
  projectionEntriesToWordbook,
  type ProjectionEntry,
  type ProjectionWordbookEntry,
} from '../../features/wordbook/wordbookProjection'
import { useDocumentsStore } from './documents'
import { useWordStatesStore } from './wordStates'

export type WordbookStoreStatus = 'idle' | 'loading' | 'ready' | 'error'

type WordStateChange = {
  languageCode: string
  lemma: string
  state: WordState
}

type WordbookState = {
  /** Mapped rows by language, in projection/read order. */
  entriesByLanguage: Record<string, ProjectionWordbookEntry[]>
  /** Languages whose projection rows have been read into this store. */
  loadedLanguages: Record<string, true>
  /**
   * Persisted projection completeness per language.
   *
   * Read from the device's `documentMeta` projection state. This is what lets an
   * R2 upgrade keep its local wordbook and lets a new device show "preparing"
   * before the first projection pull finishes.
   */
  projectionCompleteByLanguage: Record<string, boolean>
  /**
   * Persisted pause metadata per language. This is the reload source of truth
   * for the paused banner; the in-memory sync report is only a transient view.
   */
  projectionPauseByLanguage: Record<string, ProjectionPause>
  /** Load state for the latest projection read. */
  status: WordbookStoreStatus
  error: string | null
  /** Monotonic counter — lets callers memoize worker work without deep compares. */
  revision: number
  /**
   * Increments only when projection content is replaced (load/title remap).
   * Word-state patches leave it alone, so the search index is not rebuilt for a
   * one-row edit.
   */
  dataRevision: number
  /**
   * Re-reads projection rows. With a language, only that language is replaced.
   * Without one, every local projection row is read (the document list needs
   * progress for all languages at once).
   */
  refreshFromStore: (languageCode?: string) => Promise<void>
  /** Reads which languages have a complete projection for this account. */
  refreshProjectionReadiness: (userId: string | null) => Promise<void>
  /** Replaces mapped entries directly (tests). */
  setEntries: (languageCode: string, entries: ProjectionWordbookEntry[]) => void
  /**
   * Replaces one language with rows the local-only producer built (Task 11).
   *
   * The raw projection rows are remembered too, so a document rename
   * re-resolves titles from metadata exactly as a server projection row does.
   */
  setLocalEntries: (languageCode: string, entries: ProjectionEntry[]) => void
  /**
   * Patches only the rows a local change touched, keeping every other row's
   * identity — a status edit or one document's words never remap the language.
   */
  applyLocalEntries: (
    languageCode: string,
    entries: ProjectionEntry[],
    removedLemmas?: readonly string[],
  ) => void
  /** Applies local word-state changes to just the matching rows. */
  applyWordStates: (changes: readonly WordStateChange[]) => void
  /** Re-resolves context titles from current document metadata. */
  resolveDocumentTitles: (documents?: readonly { id: string; title: string }[]) => void
}

/** Raw projection rows kept only for title re-resolution (document renames). */
const rawByLanguage = new Map<string, ProjectionEntry[]>()

/** `languageCode → lemma → index` for O(1) entry patches. */
const indicesByLanguage = new Map<string, Map<string, number>>()

function rememberEntries(languageCode: string, entries: ProjectionWordbookEntry[]): void {
  const index = new Map<string, number>()
  entries.forEach((entry, position) => index.set(entry.lemma, position))
  indicesByLanguage.set(languageCode, index)
}

function stateForKey(key: string): { languageCode: string; lemma: string } | null {
  const separator = key.indexOf('::')
  if (separator <= 0) return null
  return { languageCode: key.slice(0, separator), lemma: key.slice(separator + 2) }
}

/** Title signature — only a title change (or a document appearing/leaving) triggers a remap. */
function documentsTitleSignature(
  documents: readonly { id: string; title: string }[],
): string {
  return documents.map((doc) => `${doc.id}\u0000${doc.title}`).join('\u0001')
}

export const useWordbookStore = create<WordbookState>((set, get) => ({
  entriesByLanguage: {},
  loadedLanguages: {},
  projectionCompleteByLanguage: {},
  projectionPauseByLanguage: {},
  status: 'idle',
  error: null,
  revision: 0,
  dataRevision: 0,

  refreshFromStore: async (languageCode) => {
    set({ status: 'loading', error: null })
    try {
      let rows: ProjectionEntry[]
      if (languageCode) {
        rows = await readWordbookEntries(languageCode)
      } else {
        rows = await idbGetAll<ProjectionEntry>(STORES.wordbookEntries)
      }

      const grouped = new Map<string, ProjectionEntry[]>()
      if (languageCode) {
        grouped.set(languageCode, rows)
      } else {
        for (const row of rows) {
          const list = grouped.get(row.languageCode)
          if (list) list.push(row)
          else grouped.set(row.languageCode, [row])
        }
      }

      const documents = useDocumentsStore.getState().documents
      const byKey = useWordStatesStore.getState().byKey
      const mapped: Record<string, ProjectionWordbookEntry[]> = {}
      for (const [code, records] of grouped) {
        rawByLanguage.set(code, records)
        mapped[code] = projectionEntriesToWordbook(records, {
          documents,
          stateOf: (lemma) => byKey[`${code}::${lemma}`],
        })
        rememberEntries(code, mapped[code])
      }

      set((s) => ({
        entriesByLanguage: languageCode
          ? { ...s.entriesByLanguage, [languageCode]: mapped[languageCode] ?? [] }
          : mapped,
        loadedLanguages: languageCode
          ? { ...s.loadedLanguages, [languageCode]: true }
          : Object.fromEntries(Object.keys(mapped).map((code) => [code, true as const])),
        status: 'ready',
        revision: s.revision + 1,
        dataRevision: s.dataRevision + 1,
      }))
    } catch (error) {
      set({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },

  refreshProjectionReadiness: async (userId) => {
    if (!userId) {
      set({ projectionCompleteByLanguage: {}, projectionPauseByLanguage: {} })
      return
    }
    try {
      const states = await readProjectionState(userId)
      const complete: Record<string, boolean> = {}
      const paused: Record<string, ProjectionPause> = {}
      for (const [languageCode, state] of Object.entries(states)) {
        complete[languageCode] = state.complete
        if (state.pause !== undefined) paused[languageCode] = state.pause
      }
      set({ projectionCompleteByLanguage: complete, projectionPauseByLanguage: paused })
    } catch (error) {
      // Unreadable state means "not complete" — the local wordbook stays
      // visible rather than the screen claiming an empty wordbook.
      console.error('단어장 준비 상태 읽기 실패', error)
      set({ projectionCompleteByLanguage: {}, projectionPauseByLanguage: {} })
    }
  },

  setEntries: (languageCode, entries) => {
    rememberEntries(languageCode, entries)
    set((s) => ({
      entriesByLanguage: { ...s.entriesByLanguage, [languageCode]: entries },
      loadedLanguages: { ...s.loadedLanguages, [languageCode]: true },
      revision: s.revision + 1,
      dataRevision: s.dataRevision + 1,
    }))
  },

  setLocalEntries: (languageCode, entries) => {
    rawByLanguage.set(languageCode, [...entries])
    const documents = useDocumentsStore.getState().documents
    const byKey = useWordStatesStore.getState().byKey
    get().setEntries(
      languageCode,
      projectionEntriesToWordbook(entries, {
        documents,
        stateOf: (lemma) => byKey[`${languageCode}::${lemma}`],
      }),
    )
  },

  applyLocalEntries: (languageCode, entries, removedLemmas = []) => {
    if (entries.length === 0 && removedLemmas.length === 0) return
    const documents = useDocumentsStore.getState().documents
    const byKey = useWordStatesStore.getState().byKey
    const mapped = projectionEntriesToWordbook(entries, {
      documents,
      stateOf: (lemma) => byKey[`${languageCode}::${lemma}`],
    })

    const raw = rawByLanguage.get(languageCode)
    if (raw) {
      const byLemma = new Map(raw.map((row) => [row.lemma, row]))
      for (const lemma of removedLemmas) byLemma.delete(lemma)
      for (const row of entries) byLemma.set(row.lemma, row)
      rawByLanguage.set(languageCode, [...byLemma.values()])
    }

    const current = get().entriesByLanguage[languageCode]
    // Not loaded yet: a full build is still pending, and inventing a partial
    // list here would hide every row that build has not produced yet.
    if (!current) return

    const patches = new Map(mapped.map((entry) => [entry.lemma, entry]))
    if (removedLemmas.length > 0) {
      const removed = new Set(removedLemmas)
      const next = current
        .filter((entry) => !removed.has(entry.lemma))
        .map((entry) => {
          const patch = patches.get(entry.lemma)
          if (!patch) return entry
          patches.delete(entry.lemma)
          return patch
        })
      for (const patch of patches.values()) next.push(patch)
      rememberEntries(languageCode, next)
      set((s) => ({
        entriesByLanguage: { ...s.entriesByLanguage, [languageCode]: next },
        revision: s.revision + 1,
        dataRevision: s.dataRevision + 1,
      }))
      return
    }

    let index = indicesByLanguage.get(languageCode)
    if (!index) {
      index = new Map()
      current.forEach((entry, position) => index?.set(entry.lemma, position))
      indicesByLanguage.set(languageCode, index)
    }
    let copy: ProjectionWordbookEntry[] | null = null
    for (const patch of patches.values()) {
      if (!copy) copy = current.slice()
      const position = index.get(patch.lemma)
      if (position === undefined) {
        index.set(patch.lemma, copy.length)
        copy.push(patch)
      } else {
        copy[position] = patch
      }
    }
    if (!copy) return
    const next = copy
    set((s) => ({
      entriesByLanguage: { ...s.entriesByLanguage, [languageCode]: next },
      revision: s.revision + 1,
      dataRevision: s.dataRevision + 1,
    }))
  },

  applyWordStates: (changes) => {
    if (changes.length === 0) return
    const byLanguage = new Map<string, Map<string, WordState>>()
    for (const change of changes) {
      let lemmas = byLanguage.get(change.languageCode)
      if (!lemmas) {
        lemmas = new Map()
        byLanguage.set(change.languageCode, lemmas)
      }
      lemmas.set(change.lemma, change.state)
    }

    let changed = false
    const next: Record<string, ProjectionWordbookEntry[]> = {}
    for (const [code, updates] of byLanguage) {
      const entries = get().entriesByLanguage[code]
      if (!entries || entries.length === 0) continue
      let index = indicesByLanguage.get(code)
      if (!index) {
        index = new Map<string, number>()
        entries.forEach((entry, position) => index?.set(entry.lemma, position))
        indicesByLanguage.set(code, index)
      }

      let copy: ProjectionWordbookEntry[] | null = null
      for (const [lemma, state] of updates) {
        const position = index.get(lemma)
        if (position === undefined) continue
        if (!copy) copy = entries.slice()
        const entry = copy[position]
        copy[position] = {
          ...entry,
          status: state.status ?? 'unmarked',
          favorite: state.favorite,
          starColor: state.starColor,
          note: state.note,
          lastSeenAt: state.lastSeenAt,
          knownPresses: state.knownPresses,
        }
        changed = true
      }
      if (copy) next[code] = copy
    }

    if (!changed) return
    set((s) => ({
      entriesByLanguage: { ...s.entriesByLanguage, ...next },
      revision: s.revision + 1,
    }))
  },

  resolveDocumentTitles: (documents) => {
    if (rawByLanguage.size === 0) return
    const source = documents ?? useDocumentsStore.getState().documents
    const byKey = useWordStatesStore.getState().byKey
    const entriesByLanguage: Record<string, ProjectionWordbookEntry[]> = {}
    for (const [code, records] of rawByLanguage) {
      const entries = projectionEntriesToWordbook(records, {
        documents: source,
        stateOf: (lemma) => byKey[`${code}::${lemma}`],
      })
      entriesByLanguage[code] = entries
      rememberEntries(code, entries)
    }
    set((s) => ({
      entriesByLanguage: { ...s.entriesByLanguage, ...entriesByLanguage },
      revision: s.revision + 1,
      dataRevision: s.dataRevision + 1,
    }))
  },
}))

/**
 * Local word-state edits should be visible on the wordbook row immediately,
 * without waiting for a projection pull. Zustand gives us the previous and next
 * `byKey`; only references that actually changed are patched.
 */
let previousByKey = useWordStatesStore.getState().byKey
useWordStatesStore.subscribe((state) => {
  const nextByKey = state.byKey
  if (nextByKey === previousByKey) return
  const previous = previousByKey
  previousByKey = nextByKey

  const changes: WordStateChange[] = []
  for (const key in nextByKey) {
    if (nextByKey[key] === previous[key]) continue
    const parsed = stateForKey(key)
    if (!parsed) continue
    changes.push({ ...parsed, state: nextByKey[key] })
  }
  if (changes.length > 0) useWordbookStore.getState().applyWordStates(changes)
})

/**
 * Projection contexts carry document ids, not titles. A rename (or a document
 * appearing after the projection loaded) must update the visible title without
 * re-reading the projection from IndexedDB.
 */
let previousDocuments = useDocumentsStore.getState().documents
let titleSignature = documentsTitleSignature(previousDocuments)
useDocumentsStore.subscribe((state) => {
  if (state.documents === previousDocuments) return
  previousDocuments = state.documents
  const nextSignature = documentsTitleSignature(state.documents)
  if (nextSignature === titleSignature) return
  titleSignature = nextSignature
  useWordbookStore.getState().resolveDocumentTitles(state.documents)
})
