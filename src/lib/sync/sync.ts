import type { SupabaseClient } from '@supabase/supabase-js'

import {
  STORES,
  SYNC_META_KEY,
  clearDirtyIfRevision,
  idbCount,
  idbGet,
  idbGetAll,
  isReservedDocumentMetaId,
  normalizeLocalSyncMeta,
  openLocalDatabase,
  readDirtyKeys,
  readLocalRevision,
  wordStateDirtyKey,
} from '../storage/localDb'
import {
  clearWordbookEntries,
  mergeWordbookEntries,
  putWordbookEntries,
  type WordbookEntryInput,
} from '../storage/wordbookEntries'
import { mergeOccurrences } from './mergeOccurrences'
import { purgedDocumentIds, LEGACY_PURGE_AT, type DocumentTombstone } from '../storage/purged'
import { LEMMA_VERSION } from '../../features/reader/surfaceLemma'
import { supabase } from '../supabase/client'
import type { Database } from '../supabase/database.types'
import type { Document, Folder } from '../../types'
import type { WordOccurrence } from '../../app/stores/occurrences'
import {
  isNewer,
  mergeDocuments,
  mergeFolders,
  mergeLanguages,
  mergeTombstones,
  mergeWordStates,
  normalizeWordState,
  type StoredWordState,
  type WordStateRecord,
} from './merge'
import {
  changedLocalOccurrenceDocuments,
  occurrenceContentKey,
  writeLocal,
} from './writeLocal'
import { pull } from './pull'
import { readProjectionState, updateProjectionState } from './projectionState'
import {
  loadDirtyCandidates,
  push as pushRows,
  pushOccurrences,
  wordStatePushKey,
} from './push'
import { clearPushOnClockRollback } from './syncState'
import type { ProjectionRow } from './wordbookPull'
import type {
  PullResult,
  PullWatermarks,
  PushWatermarks,
  SyncReport,
  SyncWarning,
} from './types'

export type { PullResult, PullWatermarks, PushWatermarks, SyncReport } from './types'
export type {
  DirtyKey,
  PushResult,
  PushTable,
  SyncFailure,
  SyncWarning,
} from './types'
export { pull } from './pull'
export { push, pushOccurrences } from './push'
export { changedLocalOccurrenceDocuments, writeLocal } from './writeLocal'
export type { WriteLocalOptions, WriteLocalResult } from './writeLocal'
// Kept here so existing imports (sync.ts as the public sync surface) still work.
export { mergeDocuments, mergeFolders, mergeTombstones }

export type SyncStatus = 'local' | 'syncing' | 'synced' | 'error'

/**
 * 로컬 ↔ 서버 동기화 (plan.txt 1줄: 기기가 바뀌어도 학습이 이어진다).
 *
 * 순서는 pull → merge → push 다. push 를 먼저 하면 이 기기의 옛 상태로 서버를
 * 덮어써서 다른 기기에서 방금 한 작업을 잃는다.
 *
 * 읽기 실패를 throw 하지 않는다. 동기화는 언제든 실패할 수 있고(오프라인,
 * 세션 만료), 앱은 로컬 데이터만으로 계속 동작해야 한다. 실패는 상태로 알린다.
 */

export class SyncUnavailable extends Error {
  constructor() {
    super('Supabase 미설정')
    this.name = 'SyncUnavailable'
  }
}

/**
 * A sync cycle was abandoned because local writes kept landing while it planned.
 *
 * Nothing was written and no watermark moved: the caller must leave its stored
 * progress untouched and retry quietly once the writes settle. This is not an
 * error the user can act on, so it never becomes an error banner.
 */
export class SyncDeferredError extends Error {
  constructor() {
    super('로컬 변경이 계속되어 이번 동기화를 미뤘습니다')
    this.name = 'SyncDeferredError'
  }
}

function client(): SupabaseClient<Database> {
  if (!supabase) throw new SyncUnavailable()
  return supabase
}

/**
 * 로컬 IndexedDB 를 읽는다.
 *
 * 배울 언어는 localStorage 를 쓰는 스토어에 있어 호출부가 넘긴다 —
 * 여기서 다시 들면 같은 사실이 두 곳에 생긴다.
 */
export async function readLocal(): Promise<{
  documents: Document[]
  folders: Folder[]
  wordStates: WordStateRecord[]
  occurrences: WordOccurrence[]
  tombstones: DocumentTombstone[]
}> {
  const [documents, folders, wordStates, occurrences, tombstones] = await Promise.all([
    idbGetAll<Document>(STORES.documents),
    idbGetAll<Folder>(STORES.folders),
    idbGetAll<StoredWordState>(STORES.wordStates),
    idbGetAll<WordOccurrence>(STORES.wordOccurrences),
    idbGetAll<DocumentTombstone>(STORES.documentTombstones),
  ])

  return {
    // 옛 행에는 폴더 인장이 없다 — 없던 것을 있는 것은 아니지만, 폴더가 없는 것
    // 자체는 있다 (루트). 인장만 문서를 연 시각으로 채워 병합이 자리를 갖게 한다
    documents: documents.map((doc) => ({
      ...doc,
      folderId: doc.folderId ?? null,
      folderUpdatedAt: doc.folderUpdatedAt ?? doc.updatedAt,
    })),
    folders,
    wordStates: wordStates.map(normalizeWordState),
    occurrences,
    tombstones,
  }
}

type LocalSnapshot = Awaited<ReturnType<typeof readLocal>>

// The server default; duplicated instead of importing an app-store constant
// into the sync layer.
const PROJECTION_STAR_COLOR_DEFAULT = '#eab308'

/** One server projection row in the shape the local read model stores. */
export function projectionRowToEntry(row: ProjectionRow): WordbookEntryInput {
  return {
    languageCode: row.language_code,
    lemma: row.lemma,
    surfaces: row.surfaces ?? [],
    contexts: (row.contexts ?? []) as WordbookEntryInput['contexts'],
    occurrenceCount: row.occurrence_count ?? 0,
    documentCount: row.document_count ?? 0,
    status: row.status ?? null,
    isFavorite: row.is_favorite ?? false,
    starAngle: row.star_angle ?? 0,
    starColor: row.star_color ?? PROJECTION_STAR_COLOR_DEFAULT,
    seenCount: row.seen_count ?? 1,
    firstSeenAt: row.first_seen_at ?? null,
    lastSeenAt: row.last_seen_at ?? null,
    favoriteUpdatedAt: row.favorite_updated_at ?? null,
    knownPresses: row.known_presses ?? 0,
    unsurePresses: row.unsure_presses ?? 0,
    unknownPresses: row.unknown_presses ?? 0,
    note: row.note ?? null,
    noteUpdatedAt: row.note_updated_at ?? null,
    serverUpdatedAt: row.server_updated_at ?? null,
    deletedAt: row.deleted_at ?? null,
  }
}

/**
 * A projection row's state fields as a word state.
 *
 * The projection is the server's canonical copy, so its nullable timestamps
 * fall back to the row watermark rather than inventing a later "seen" time.
 */
export function projectionRowToWordState(row: ProjectionRow): WordStateRecord {
  const stamp =
    row.server_updated_at ?? row.last_seen_at ?? row.first_seen_at ?? new Date(0).toISOString()
  return normalizeWordState({
    languageCode: row.language_code,
    lemma: row.lemma,
    status: row.status ?? undefined,
    seenCount: row.seen_count ?? 1,
    firstSeenAt: row.first_seen_at ?? stamp,
    lastSeenAt: row.last_seen_at ?? stamp,
    favorite: row.is_favorite ?? false,
    favoriteUpdatedAt: row.favorite_updated_at ?? undefined,
    starAngle: row.star_angle ?? 0,
    starColor: row.star_color ?? PROJECTION_STAR_COLOR_DEFAULT,
    knownPresses: row.known_presses ?? 0,
    unsurePresses: row.unsure_presses ?? 0,
    unknownPresses: row.unknown_presses ?? 0,
    note: row.note ?? undefined,
    noteUpdatedAt: row.note_updated_at ?? undefined,
  })
}

/**
 * A local-only projection entry built from an unpushed word state.
 *
 * Used after a manual full resync clears a language: a dirty key has no
 * canonical projection row yet, so the row is re-seeded from the local state
 * instead of disappearing until the edit is pushed and the next incremental
 * projection returns it. Counts and contexts are derived data and stay empty
 * for this cycle.
 */
function entryFromWordState(state: WordStateRecord): WordbookEntryInput {
  return {
    languageCode: state.languageCode,
    lemma: state.lemma,
    surfaces: [state.lemma],
    contexts: [],
    occurrenceCount: 0,
    documentCount: 0,
    status: state.status ?? null,
    isFavorite: state.favorite,
    starAngle: state.starAngle,
    starColor: state.starColor,
    seenCount: state.seenCount,
    firstSeenAt: state.firstSeenAt,
    lastSeenAt: state.lastSeenAt,
    favoriteUpdatedAt: state.favoriteUpdatedAt,
    knownPresses: state.knownPresses,
    unsurePresses: state.unsurePresses,
    unknownPresses: state.unknownPresses,
    note: state.note ?? null,
    noteUpdatedAt: state.noteUpdatedAt ?? null,
    serverUpdatedAt: null,
  }
}

/**
 * Rows applied per projection transaction. Keeps the dirty-journal lock short
 * and hydration memory bounded while staying far below the 1 MB page budget.
 */
const PROJECTION_APPLY_BATCH = 500

function chunkRows<T>(rows: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size))
  }
  return chunks
}

/** The later of two ISO timestamps; an unreadable value loses. */
function laterTimestamp(current: string | undefined, candidate: string): string {
  if (current === undefined) return candidate
  const currentAt = Date.parse(current)
  const candidateAt = Date.parse(candidate)
  if (Number.isNaN(currentAt)) return candidate
  if (Number.isNaN(candidateAt)) return current
  return candidateAt > currentAt ? candidate : current
}

type ProjectionHydration = {
  /** Rows this device did not have before (mirrors `pullOnly`). */
  created: number
  /** Rows written, including a field-level update of an existing state. */
  written: number
}

/**
 * Writes hydrated word states for one projection batch, silently.
 *
 * Runs in one transaction over the reserved sync meta and `wordStates` so the
 * dirty journal is read and the rows are written without a window in which a
 * local edit can be overwritten. The write is raw (`store.put`), never a user
 * write: no revision bump, no pending count, no dirty key, no signal.
 *
 * `skipped` is the dirty set the projection merge saw; the journal is checked
 * again here because an edit can land between the merge and this transaction.
 */
function hydrateWordStates(
  rows: readonly ProjectionRow[],
  skipped: ReadonlyArray<{ languageCode: string; lemma: string }>,
): Promise<ProjectionHydration> {
  const skippedKeys = new Set(
    skipped.map((key) => wordStateDirtyKey(key.languageCode, key.lemma)),
  )

  return openLocalDatabase().then(
    (db) =>
      new Promise<ProjectionHydration>((resolve, reject) => {
        const transaction = db.transaction(
          [STORES.documentMeta, STORES.wordStates],
          'readwrite',
        )
        const metaStore = transaction.objectStore(STORES.documentMeta)
        const stateStore = transaction.objectStore(STORES.wordStates)
        const metaRequest = metaStore.get(SYNC_META_KEY)

        let created = 0
        let written = 0
        let planned = false
        let failure: unknown

        metaRequest.onsuccess = () => {
          try {
            const meta = normalizeLocalSyncMeta(metaRequest.result)
            const dirty = meta?.dirty[STORES.wordStates] ?? {}
            for (const row of rows) {
              // A soft-deleted projection row removes the wordbook entry; it is
              // not evidence for a new word state on this device.
              if (row.deleted_at !== null && row.deleted_at !== undefined) continue
              const key = wordStateDirtyKey(row.language_code, row.lemma)
              if (skippedKeys.has(key) || dirty[key] !== undefined) continue

              // Field-level merge, not last-row-wins: a star or note edited on
              // this device must survive a projection row that is older for
              // that one field. The read and the write stay in this transaction.
              const server = projectionRowToWordState(row)
              const getRequest = stateStore.get([row.language_code, row.lemma])
              getRequest.onsuccess = () => {
                try {
                  const existing = getRequest.result as StoredWordState | undefined
                  const next =
                    existing === undefined
                      ? server
                      : mergeWordStates([normalizeWordState(existing)], [server]).merged[0]
                  if (existing === undefined) created += 1
                  stateStore.put(next)
                  written += 1
                } catch (error) {
                  failure = error
                  transaction.abort()
                }
              }
              // A failed request aborts the transaction on its own.
              getRequest.onerror = () => {}
            }
            planned = true
          } catch (error) {
            failure = error
            transaction.abort()
          }
        }
        // A failed request aborts the transaction on its own — onabort rejects.
        metaRequest.onerror = () => {}

        transaction.oncomplete = () => {
          if (!planned) {
            reject(new Error('word-state hydration transaction completed without a plan'))
            return
          }
          resolve({ created, written })
        }
        transaction.onerror = () => {}
        transaction.onabort = () =>
          reject(
            failure ?? transaction.error ?? new Error('word-state hydration was aborted'),
          )
      }),
  )
}

type SyncPlan = {
  words: ReturnType<typeof mergeWordStates>
  languages: string[]
  folders: Folder[]
  tombstones: DocumentTombstone[]
  tombstoneIds: Set<string>
  remoteDocs: Document[]
  metaRows: Array<{
    documentId: string
    lemmaVersion: number
    occurrencesUpdatedAt?: string
  }>
  mergedDocuments: Document[]
  mergedWords: WordStateRecord[]
  occurrences: WordOccurrence[]
  occurrenceDocumentIds: Set<string>
  changedDuringSync: Set<string>
}

/**
 * Builds one cycle's local write plan from a server snapshot and a local read.
 *
 * Split out so a local write that lands during the pull can be re-planned from
 * a fresh read without duplicating the merge rules.
 */
async function planLocalWrite(
  remote: PullResult,
  local: LocalSnapshot,
  localLanguages: string[],
  syncStartedAt: string,
): Promise<SyncPlan> {
  const words = mergeWordStates(local.wordStates, remote.wordStates)
  const languages = mergeLanguages(localLanguages, remote.languages)
  const folders = mergeFolders(local.folders, remote.folders)

  /**
   * 이 기기에서 완전 삭제한 문서는 서버 것이 남아 있어도 받지 않는다.
   *
   * 삭제 요청과 이 조회가 겹치면 지운 문서가 그대로 내려온다. 병합은 그걸 되살리고,
   * 다음 동기화는 되살아난 것을 서버에 다시 올린다 — 지운 문서가 영구히 되돌아온다.
   */
  /**
   * 완전 삭제는 묘비로 나른다.
   *
   * 문서 행이 서버에서 사라진 것을 다른 기기가 '이 기기에만 있는 문서' 로 오해해
   * 다시 올리면 삭제가 무효가 된다. 이 기기의 묘비와 서버의 묘비를 합쳐, 지운
   * 문서는 어느 쪽에서도 살아나지 않게 한다.
   *
   * 옛 버전의 localStorage 목록에만 남은 삭제도 묘비로 승격한다 — 그러지 않으면
   * 그 문서는 이 기기에서만 지워진 채로 남는다.
   */
  const legacyPurged = purgedDocumentIds()
  const localTombstones = [
    ...local.tombstones,
    ...legacyPurged
      .filter((id) => !local.tombstones.some((t) => t.documentId === id))
      .map((id) => ({ documentId: id, purgedAt: LEGACY_PURGE_AT })),
  ]
  const tombstones = mergeTombstones(localTombstones, remote.tombstones)
  const tombstoneIds = new Set(tombstones.map((t) => t.documentId))
  const isLive = (id: string) => !tombstoneIds.has(id)

  const liveRemote = remote.documents.filter((d) => isLive(d.id))
  const liveOccurrences = remote.occurrences.filter((o) => isLive(o.document_id))
  const remoteDocs = liveRemote

  /**
   * 이 기기에서 **현재 규칙으로 다시 계산한** 문서.
   *
   * 서버에 옛 표기 규칙이 만든 기록이 남아 있고, 동기화는 그것을 매번 다시 넣어준다.
   * 새 규칙에서 나오지 않는 키는 같은 키로 덮어써지지 않으므로 살아남는다 — 목록과
   * 본문이 서로 다른 진도를 보인다 (mergeOccurrences.ts).
   */
  const metaRowsAll = await idbGetAll<{
    documentId: string
    lemmaVersion: number
    occurrencesUpdatedAt?: string
  }>(STORES.documentMeta).catch(
    () => [] as { documentId: string; lemmaVersion: number; occurrencesUpdatedAt?: string }[],
  )
  // Reserved device bookkeeping (sync meta, projection state) is not a document row
  const metaRows = metaRowsAll.filter((m) => !isReservedDocumentMetaId(m.documentId))
  const recomputed = new Set(
    metaRows.filter((m) => m.lemmaVersion === LEMMA_VERSION).map((m) => m.documentId),
  )

  /**
   * 서버가 준 문서는 등장 기록도 **통째로** 교체한다 — 증분 동기화는 이번에
   * 등장 기록을 실제로 읽은 문서가 대상이다. 그러지 않으면 서버에서 사라진 옛
   * 키가 로컬에 남는다. 로컬에서 다시 계산한 문서는 로컬이 이긴다 — 서버의 옛
   * 표기 기록을 받지 않는다.
   *
   * 첫 동기화는 등장 기록을 아예 읽지 않는다 (단어장은 projection 이 나른다).
   * 그때 `occurrenceDocumentIds` 가 비어 있으므로 로컬 등장 기록을 지우지
   * 않는다 — R2 기기의 단어장이 projection 을 받는 동안에도 그대로 보여야 한다.
   */
  const fetchedOccurrenceIds = new Set(remote.occurrenceDocumentIds)
  const replaceDocuments = new Set(
    [...fetchedOccurrenceIds].filter((id) => !recomputed.has(id)),
  )

  const occurrences = mergeOccurrences(
    local.occurrences,
    liveOccurrences,
    recomputed,
    [...local.documents.filter((d) => isLive(d.id)), ...remoteDocs],
    tombstoneIds,
    replaceDocuments,
  )

  const mergedDocuments = mergeDocuments(
    local.documents.filter((d) => isLive(d.id)),
    remoteDocs,
  )
  // 없앤 표시도 status = null 인 행으로 남긴다 — 행 자체가 즐겨찾기·메모·횟수를 든다
  const mergedWords = words.merged

  /**
   * 동기화가 도는 동안 이 기기에서 등장 기록을 다시 계산했을 수 있다.
   * 그 문서는 이번에 덮어쓰지 않고 다음 동기화가 새 기록을 보낸다.
   */
  const latestMetaAll = await idbGetAll<{
    documentId: string
    occurrencesUpdatedAt?: string
  }>(STORES.documentMeta).catch(
    () => [] as { documentId: string; occurrencesUpdatedAt?: string }[],
  )
  // Reserved device bookkeeping never carries a document's stamp
  const latestMeta = latestMetaAll.filter((m) => !isReservedDocumentMetaId(m.documentId))
  const changedDuringSync = new Set(
    latestMeta
      .filter(
        (m) =>
          m.occurrencesUpdatedAt !== undefined &&
          Date.parse(m.occurrencesUpdatedAt) > Date.parse(syncStartedAt),
      )
      .map((m) => m.documentId),
  )

  /**
   * Only documents whose merged occurrence content differs from the local
   * snapshot are written. A no-change sync — including the five-minute overlap
   * pulling a document again, or a document opened elsewhere with identical
   * occurrences — must not replace rows that are already correct. A document
   * whose merged rows are gone stays in the set; `writeLocal` clears it with an
   * empty list. Documents recomputed while the sync was running are skipped:
   * their fresh local rows are newer than this plan.
   */
  const occurrenceDocumentIds = new Set(
    changedLocalOccurrenceDocuments(occurrences, local.occurrences).filter(
      (documentId) => !changedDuringSync.has(documentId),
    ),
  )
  return {
    words,
    languages,
    folders,
    tombstones,
    tombstoneIds,
    remoteDocs,
    metaRows,
    mergedDocuments,
    mergedWords,
    occurrences,
    occurrenceDocumentIds,
    changedDuringSync,
  }
}

/**
 * 동기화 한 사이클.
 *
 * 1. 서버를 읽는다
 * 2. 로컬과 병합한다
 * 3. 병합 결과를 로컬에 쓴다
 * 4. 서버에 없는 것만 서버에 쓴다
 */
export async function syncOnce({
  userId,
  languages: localLanguages,
  db = client(),
  since,
  push: pushWatermarks = {},
  pushedAt,
  resetProjection = false,
  projectionByteBudget,
}: {
  userId: string
  /** 이 기기에서 배운 언어 */
  languages: string[]
  db?: SupabaseClient<Database>
  /** 서버 워터마크 — 없으면 전체를 읽는다 */
  since?: PullWatermarks
  /** Per-table client-time push watermarks. A missing table pushes everything. */
  push?: PushWatermarks
  /** @deprecated R1 single watermark; translated to every table for old callers. */
  pushedAt?: string
  /**
   * The user asked for a full resync. The projection is re-downloaded from a
   * fresh snapshot instead of resuming, and the language is cleared first so a
   * soft-deleted row cannot survive as a phantom.
   */
  resetProjection?: boolean
  /** Override the soft projection byte budget (tests only). */
  projectionByteBudget?: number
}): Promise<SyncReport> {
  // This snapshot of server and local data is the plan for one sync attempt.
  const syncStartedAt = new Date().toISOString()
  // Captured before readLocal: a write between these two reads must still be
  // detected as a change, not silently folded into the snapshot.
  const revisionBefore = await readLocalRevision()
  const projectionState = await readProjectionState(userId)
  const [remote, firstLocal] = await Promise.all([
    pull(userId, db, since, {
      languages: localLanguages,
      projectionState,
      resetProjection,
      projectionByteBudget,
    }),
    readLocal(),
  ])

  let local = firstLocal
  let plan = await planLocalWrite(remote, local, localLanguages, syncStartedAt)
  let expectedRevision = await readLocalRevision()
  if (expectedRevision !== revisionBefore) {
    // A local write landed while the pull was in flight. Re-read once and
    // rebuild the plan so the merge sees the newer row; replacing occurrences
    // from the stale snapshot would otherwise undo that write.
    local = await readLocal()
    plan = await planLocalWrite(remote, local, localLanguages, syncStartedAt)
    const rereadRevision = await readLocalRevision()
    // Still moving — write nothing this cycle and let the caller retry quietly.
    if (rereadRevision !== expectedRevision) throw new SyncDeferredError()
    expectedRevision = rereadRevision
  }

  const {
    words,
    languages,
    folders,
    tombstones,
    tombstoneIds,
    remoteDocs,
    metaRows,
    mergedDocuments,
    mergedWords,
    occurrences,
    occurrenceDocumentIds,
    changedDuringSync,
  } = plan

  const localWrites = await writeLocal(
    mergedDocuments,
    mergedWords,
    occurrences,
    folders,
    tombstones,
    { occurrenceDocumentIds, expectedRevision },
  )

  /**
   * Store the projection rows, then advance each language's cursor.
   *
   * The order is the whole resumability guarantee: a cursor may only name rows
   * that are already in IndexedDB. Every page is applied through the atomic
   * dirty-key merge, and its state fields are hydrated in a silent transaction
   * that re-checks the journal.
   */
  const projectionRowsByLanguage = new Map<string, ProjectionRow[]>()
  for (const row of remote.wordbookEntries) {
    const rows = projectionRowsByLanguage.get(row.language_code) ?? []
    rows.push(row)
    projectionRowsByLanguage.set(row.language_code, rows)
  }

  if (resetProjection) {
    const dirtyWordKeys = new Set(
      (await readDirtyKeys())
        .filter((dirty) => dirty.store === STORES.wordStates)
        .map((dirty) => dirty.key),
    )
    for (const language of remote.projection.full) {
      // Mark the language incomplete before clearing it. If this cycle dies
      // between the clear and the cursor write, the next cycle must start a
      // full pull rather than resume an incremental watermark over an empty
      // local language.
      await updateProjectionState(userId, language, () => ({
        complete: false,
        snapshot: null,
        cursor: null,
        hydratedAt: null,
      }))
      const seeds: WordbookEntryInput[] = []
      const prefix = `${language}\u0000`
      for (const key of dirtyWordKeys) {
        if (!key.startsWith(prefix)) continue
        const lemma = key.slice(prefix.length)
        const stored = await idbGet<StoredWordState>(STORES.wordStates, [language, lemma])
        if (stored !== undefined) seeds.push(entryFromWordState(normalizeWordState(stored)))
      }
      // Full pages contain live rows only, so a manual resync must clear first
      // or a soft-deleted row survives as a phantom. Dirty keys are seeded back
      // from their local state because the merge skips them.
      await clearWordbookEntries(language)
      if (seeds.length > 0) await putWordbookEntries(seeds)
    }
  }

  let writtenWordStates = 0
  let pulledWordStates = 0
  for (const language of remote.projection.languages) {
    const languageRows = projectionRowsByLanguage.get(language) ?? []
    for (const batch of chunkRows(languageRows, PROJECTION_APPLY_BATCH)) {
      const merged = await mergeWordbookEntries(batch.map(projectionRowToEntry))
      const hydration = await hydrateWordStates(batch, merged.skipped)
      writtenWordStates += hydration.written
      pulledWordStates += hydration.created
    }
    const nextState = remote.projection.next[language]
    if (nextState !== undefined) {
      // Never read the map and call `writeProjectionState`: another language's
      // cursor may advance while this one is being persisted.
      await updateProjectionState(userId, language, () => nextState)
    }
  }

  /**
   * Per-table watermarks: a row is a candidate when it changed after its own
   * table's watermark. The old single `pushedAt` is translated for R1 callers.
   */
  const initialPush: PushWatermarks =
    pushedAt === undefined
      ? pushWatermarks
      : {
          documents: pushWatermarks.documents ?? pushedAt,
          folders: pushWatermarks.folders ?? pushedAt,
          wordStates: pushWatermarks.wordStates ?? pushedAt,
          tombstones: pushWatermarks.tombstones ?? pushedAt,
          occurrences: pushWatermarks.occurrences ?? pushedAt,
        }

  /**
   * A clock rollback would leave every local row behind a future watermark
   * forever. Clear all push watermarks for this cycle and retry from the local
   * snapshot; the pull watermark is a server clock and is left untouched. The
   * dirty-key union below still covers a write that lands during this cycle.
   */
  const clockGuard = clearPushOnClockRollback(initialPush)
  const effectivePush = clockGuard.push
  const warnings: SyncWarning[] = clockGuard.rolledBack ? ['clock-rollback'] : []

  const watermarkMs = (table: keyof PushWatermarks): number | undefined => {
    const iso = effectivePush[table]
    if (iso === undefined) return undefined
    const at = Date.parse(iso)
    // An unreadable watermark is no evidence that a row was pushed.
    return Number.isNaN(at) ? undefined : at
  }
  const touchedAfter = (iso: string | undefined, table: keyof PushWatermarks): boolean => {
    const watermark = watermarkMs(table)
    if (watermark === undefined) return true
    if (!iso) return false
    const at = Date.parse(iso)
    return !Number.isNaN(at) && at > watermark
  }
  const wordTouched = (word: WordStateRecord): boolean => {
    const watermark = watermarkMs('wordStates')
    if (watermark === undefined) return true
    return [word.lastSeenAt, word.favoriteUpdatedAt, word.noteUpdatedAt].some(
      (iso) => iso !== undefined && Date.parse(iso) > watermark,
    )
  }

  const wordsToPush = words.pushOnly.filter(wordTouched)

  const remoteById = new Map(remoteDocs.map((d) => [d.id, d]))
  const documentsToPush = mergedDocuments.filter((doc) => {
    // 이 기기에서 마지막 동기화 이후 바뀐 문서만 — 나머지는 다시 올리지 않는다.
    // 폴더 이동은 updatedAt 을 건드리지 않고 folderUpdatedAt 만 찍는다.
    if (!touchedAfter(doc.updatedAt, 'documents') && !touchedAfter(doc.folderUpdatedAt, 'documents')) {
      return false
    }
    const theirs = remoteById.get(doc.id)
    // 새 문서
    if (!theirs) return true
    // 내용이 달라졌다
    if (theirs.title !== doc.title) return true
    if (theirs.rawText !== doc.rawText) return true
    if (theirs.languageCode !== doc.languageCode) return true
    // 휴지통 상태가 달라졌다 — 버리거나 되살린 것을 서버도 알아야 한다
    if ((theirs.deletedAt ?? null) !== (doc.deletedAt ?? null)) return true
    // 폴더가 달라졌다 — 문서를 옮긴 것을 서버도 알아야 한다
    if ((theirs.folderId ?? null) !== (doc.folderId ?? null)) return true
    // 이 기기에서 더 늦게 열었다
    return isNewer(doc.updatedAt, theirs.updatedAt)
  })

  /**
   * 등장 기록 — 이번에 바뀐 문서의 것만.
   *
   * - 서버에서 바뀐 문서: 병합 결과와 서버를 비교한다 (로컬 재계산이면 로컬이 이겨 보낸다)
   * - 이 기기에서만 바뀐 문서: documentMeta.occurrencesUpdatedAt 이 마지막 동기화 이후다
   */
  const occurrenceWatermark = watermarkMs('occurrences')
  const dirtyOccurrenceDocs = new Set(
    occurrenceWatermark === undefined
      ? local.occurrences.map((record) => record.documentId)
      : metaRows
          .filter(
            (m) =>
              m.occurrencesUpdatedAt !== undefined &&
              Date.parse(m.occurrencesUpdatedAt) > occurrenceWatermark,
          )
          .map((m) => m.documentId),
  )
  // Only documents whose occurrence rows were actually read can be compared;
  // an unread document is not evidence that its local rows are stale.
  const changedFetched = changedOccurrenceDocuments(
    occurrences,
    remote.occurrences,
    new Set(remote.occurrenceDocumentIds),
  )
  const occurrencePush = [...new Set([...changedFetched, ...dirtyOccurrenceDocs])].filter(
    (id) => !tombstoneIds.has(id) && !changedDuringSync.has(id),
  )

  /**
   * 폴더는 문서보다 **먼저** 간다 — 문서의 folder_id 가 폴더를 가리키므로(FK),
   * 폴더가 아직 없는 채로 문서가 가면 서버가 거절한다. 문서가 맞아 떨어지기
   * 전에 자리를 먼저 만들어 두는 것이다.
   */
  const foldersToPush = changedFolders(folders, remote.folders).filter((folder) =>
    touchedAfter(folder.updatedAt, 'folders'),
  )
  /**
   * A legacy tombstone has no real deletion time — the localStorage list holds
   * only ids, and older builds already wrote the epoch-0 sentinel to IndexedDB.
   * Keep it always eligible instead of letting an existing tombstones watermark
   * hide it forever; a fresh `now` would still be suppressible after a clock
   * rollback and cannot repair rows already written with the sentinel.
   */
  const tombstonesToPush = tombstones.filter(
    (tombstone) =>
      tombstone.purgedAt === LEGACY_PURGE_AT ||
      touchedAfter(tombstone.purgedAt, 'tombstones'),
  )

  /**
   * Dirty keys are the clock-safe fallback: a write that landed after the plan
   * was formed can carry a timestamp at/below the new watermark. Its current
   * local row is loaded here and unioned with the timestamp-selected rows.
   */
  const dirtyKeys = await readDirtyKeys()
  const dirtyCandidates = await loadDirtyCandidates(dirtyKeys, { tombstoneIds })
  // A journal entry whose row no longer exists has nothing to send.
  for (const dirty of dirtyCandidates.resolved) {
    await clearDirtyIfRevision(dirty.store, dirty.key, dirty.revision)
  }

  const documentCandidates = new Map<string, Document>()
  for (const document of documentsToPush) documentCandidates.set(document.id, document)
  for (const document of dirtyCandidates.documents) {
    if (tombstoneIds.has(document.id)) continue
    documentCandidates.set(document.id, document)
  }

  const wordCandidates = new Map<string, WordStateRecord>()
  for (const word of wordsToPush) wordCandidates.set(wordStatePushKey(word), word)
  for (const word of dirtyCandidates.words) wordCandidates.set(wordStatePushKey(word), word)

  const folderCandidates = new Map<string, Folder>()
  for (const folder of foldersToPush) folderCandidates.set(folder.id, folder)
  for (const folder of dirtyCandidates.folders) folderCandidates.set(folder.id, folder)

  const tombstoneCandidates = new Map<string, DocumentTombstone>()
  for (const tombstone of tombstonesToPush) {
    tombstoneCandidates.set(tombstone.documentId, tombstone)
  }
  for (const tombstone of dirtyCandidates.tombstones) {
    tombstoneCandidates.set(tombstone.documentId, tombstone)
  }

  const occurrenceCandidates = new Map<string, WordOccurrence[]>()
  for (const documentId of occurrencePush) {
    occurrenceCandidates.set(
      documentId,
      occurrences.filter((record) => record.documentId === documentId),
    )
  }
  for (const documentId of dirtyCandidates.occurrenceDocumentIds) {
    if (tombstoneIds.has(documentId) || changedDuringSync.has(documentId)) continue
    occurrenceCandidates.set(
      documentId,
      dirtyCandidates.occurrences.filter((record) => record.documentId === documentId),
    )
  }
  const occurrenceRecords = [...occurrenceCandidates.values()].flat()
  const occurrenceDocumentIdsToPush = [...occurrenceCandidates.keys()]

  const tableResult = await pushRows({
    userId,
    db,
    languages,
    documents: [...documentCandidates.values()],
    words: [...wordCandidates.values()],
    folders: [...folderCandidates.values()],
    tombstones: [...tombstoneCandidates.values()],
    dirtyKeys,
  })
  const occurrenceResult = await pushOccurrences(
    userId,
    occurrenceRecords,
    db,
    occurrenceDocumentIdsToPush,
    dirtyKeys,
  )

  const failures = [...tableResult.failures, ...occurrenceResult.failures]
  const succeededStores = new Set([
    ...tableResult.succeededStores,
    ...occurrenceResult.succeededStores,
  ])
  const succeededKeys = [...tableResult.succeededKeys, ...occurrenceResult.succeededKeys]

  // Advance only the tables that fully went through. A failed table keeps its
  // old watermark so the next cycle retries it.
  const nextPush: PushWatermarks = { ...effectivePush }
  for (const table of ['documents', 'folders', 'wordStates', 'tombstones'] as const) {
    if (tableResult.succeeded.has(table)) nextPush[table] = syncStartedAt
  }
  if (occurrenceResult.succeeded.has('occurrences')) nextPush.occurrences = syncStartedAt

  /**
   * Hydrated states are the server's own rows, not local edits. Initialize the
   * word-state push watermark to the projection snapshot so a new device does
   * not send 100k rows it just downloaded. Dirty local keys are still pushed by
   * the journal regardless of this timestamp.
   */
  if (writtenWordStates > 0) {
    nextPush.wordStates = laterTimestamp(nextPush.wordStates, remote.projection.snapshot)
  }

  const failedWordKeys = new Set(
    failures
      .filter((failure) => failure.table === 'wordStates' && failure.key !== undefined)
      .map((failure) => failure.key),
  )

  return {
    // 지운 것은 '보낸 단어' 가 아니다 — 서버에서 지운 것이지 보낸 것이 아니다
    pushed: [...wordCandidates.values()].filter(
      (word) => word.status !== undefined && !failedWordKeys.has(wordStatePushKey(word)),
    ).length,
    // Hydrated projection entries are words this device received, even though
    // they did not travel through the `word_states` pull.
    pulled: words.pullOnly.length + pulledWordStates,
    documents: mergedDocuments.length,
    languages,
    projectionLanguages: remote.projection.languages,
    projectionComplete: remote.projection.complete,
    projectionPaused: remote.projection.paused,
    watermarks: remote.watermarks,
    pushWatermarks: nextPush,
    serverWords: remote.totals.wordStates,
    serverDocuments: remote.totals.documents,
    /**
     * **이번 사이클을 마친 뒤** 이 기기에 있는 수.
     *
     * 받기 전 숫자를 그대로 쓰면, 새 기기가 단어 2500개를 받은 직후에도
     * '서버 2500 / 이 기기 0' 이라고 말한다 — 실제로는 방금 다 받았다. 숫자가
     * 상황을 설명하지 않으면 숫자를 믿는 사람이 아무것도 모른다.
     *
     * Counted from the store after projection hydration too: a device that
     * received its whole wordbook as projection rows must not report 0.
     */
    localWords: await idbCount(STORES.wordStates),
    occurrencePush: occurrenceDocumentIdsToPush,
    failures,
    warnings,
    localWrites,
    succeededStores: [...succeededStores],
    succeededKeys,
  }
}

/**
 * 서버와 달라진 등장 기록의 문서를 찾는다 — **서버가 없는 문서도 '달라진 것'** 이다.
 *
 * 표기 집합만 비교하면 안 된다. 같은 단어가 같은 자리에 있어도 문장이 바뀌거나
 * 위치·횟수가 바뀌면 서버의 기록은 낡은 것이다. 그래서 한 줄의 **내용 전체**를
 * 키로 만든다.
 */
type OccurrenceContentRow = {
  document_id: string
  lemma: string
  surface: string
  char_start: number
  char_end: number
  sentence: string
  occurrences_count?: number
}

export function changedOccurrenceDocuments(
  merged: WordOccurrence[],
  remoteRows: ReadonlyArray<OccurrenceContentRow>,
  onlyDocumentIds?: ReadonlySet<string>,
): string[] {
  const remoteKey = new Map<string, Set<string>>()
  for (const row of remoteRows) {
    const set = remoteKey.get(row.document_id) ?? new Set<string>()
    set.add(
      occurrenceContentKey(
        row.lemma,
        row.surface,
        row.char_start,
        row.char_end,
        row.sentence,
        row.occurrences_count ?? 1,
      ),
    )
    remoteKey.set(row.document_id, set)
  }

  const localKey = new Map<string, Set<string>>()
  for (const record of merged) {
    for (const surface of record.surfaces) {
      const set = localKey.get(record.documentId) ?? new Set<string>()
      set.add(
        occurrenceContentKey(
          record.lemma,
          surface,
          record.charStart,
          record.charEnd,
          record.sentence,
          record.count,
        ),
      )
      localKey.set(record.documentId, set)
    }
  }

  const documentIds = new Set([...localKey.keys(), ...remoteKey.keys()])
  const changed: string[] = []
  for (const id of documentIds) {
    if (onlyDocumentIds !== undefined && !onlyDocumentIds.has(id)) continue
    const mine = localKey.get(id) ?? new Set()
    const theirs = remoteKey.get(id) ?? new Set()
    if (mine.size !== theirs.size) {
      changed.push(id)
      continue
    }
    for (const key of mine) {
      if (!theirs.has(key)) {
        changed.push(id)
        break
      }
    }
  }
  return changed
}

/**
 * 서버와 달라진 폴더를 찾는다 — 서버가 없는 폴더도 '달라진 것' 이다.
 *
 * 문서와 같은 규칙이지만 한 가지가 다르다: **폴더에는 서버 트리거가 없다.**
 * 로컬에서 고친 시각 그대로 서버에 들어가므로, 여기서는 클라이언트 인장을
 * 그대로 믿고 비교한다.
 */
export function changedFolders(
  merged: readonly Folder[],
  remoteRows: readonly Folder[],
): Folder[] {
  const remoteById = new Map(remoteRows.map((f) => [f.id, f]))
  return merged.filter((folder) => {
    const theirs = remoteById.get(folder.id)
    // 새 폴더
    if (!theirs) return true
    if (theirs.name !== folder.name) return true
    // 부모가 달라졌다 — 만들어진 자리가 바뀐 것이다
    if ((theirs.parentId ?? null) !== (folder.parentId ?? null)) return true
    // 톰스톤 상태가 달라졌다
    if ((theirs.deletedAt ?? null) !== (folder.deletedAt ?? null)) return true
    // 이 기기에서 더 늦게 고쳤다
    return isNewer(folder.updatedAt, theirs.updatedAt)
  })
}

/** 문서를 지웠을 때 서버에서도 지운다 — 안 지우면 다른 기기에 다시 나타난다 */
export async function deleteDocumentRemote(
  userId: string,
  documentId: string,
  db: SupabaseClient<Database> = client(),
): Promise<void> {
  // word_occurrences 는 documents 의 on delete cascade 로 함께 사라진다
  const { error } = await db.from('documents').delete().eq('user_id', userId).eq('id', documentId)
  if (error) throw error
}
