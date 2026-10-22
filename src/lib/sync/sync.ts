import type { SupabaseClient } from '@supabase/supabase-js'

import { STORES, idbDelete, idbGet, idbGetAll, idbPut, replaceOccurrences } from '../storage/localDb'
import { mergeOccurrences } from './mergeOccurrences'
import { purgedDocumentIds, type DocumentTombstone } from '../storage/purged'
import { LEMMA_VERSION } from '../../features/reader/surfaceLemma'
import { supabase } from '../supabase/client'
import type { Database } from '../supabase/database.types'
import type { Document, Folder, WordStatus } from '../../types'
import type { WordOccurrence } from '../../app/stores/occurrences'
import { STAR_COLOR_DEFAULT } from '../../app/stores/settings'
import { isNewer, mergeLanguages, mergeWordStates, type WordStateRecord } from './merge'
import {
  documentFromRow,
  documentTombstoneFromRow,
  documentTombstoneToRow,
  documentToRow,
  folderFromRow,
  folderToRow,
  wordStateFromRow,
  wordStateToRow,
  type DocumentRow,
  type DocumentTombstoneRow,
  type FolderRow,
  type OccurrenceRow,
  type WordStateRow,
} from './mapping'

export type SyncStatus = 'local' | 'syncing' | 'synced' | 'error'

export type PullWatermarks = {
  /** 서버가 마지막으로 찍은 시각 — 이 이후에 바뀐 행만 다음에 읽는다 */
  documents?: string
  folders?: string
  wordStates?: string
  tombstones?: string
}

export type SyncReport = {
  pushed: number
  pulled: number
  documents: number
  /** 병합된 배운 언어 — 호출한 쪽이 이 기기에 채택해야 한다 */
  languages: string[]
  /** 다음 동기화가 이어 읽을 서버 워터마크 */
  watermarks: PullWatermarks
  /**
   * **서버에 지금 있는** 단어 상태와 문서 수.
   *
   * 기기마다 진도가 다를 때 이 숫자가 가감을 알려 준다. 0 이면 이 기기의 변경이
   * 서버에 가지 않은 것이고, 0 이 아니면서 이 기기에 없는 것이면 **화면에만 안 보이는**
   * 것이다 — 방향이 완전히 다르다.
   */
  serverWords: number
  serverDocuments: number
  /** 이 기기에 지금 있는 단어 상태 수 */
  localWords: number
  /**
   * 서버와 달라져서 **등장 기록을 다시 보내야 하는** 문서.
   *
   * 비어 있으면 아무것도 보내지 않는다.
   */
  occurrencePush: string[]
}

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
    idbGetAll<
      Omit<
        WordStateRecord,
        'favorite' | 'favoriteUpdatedAt' | 'starAngle' | 'starColor' | 'note' | 'noteUpdatedAt'
      > & {
        surface?: string
        status?: WordStatus
        /** 별 기능 이전에 쓰인 행에는 없다 */
        favorite?: boolean
        favoriteUpdatedAt?: string
        starAngle?: number
        starColor?: string
        /** 메모 기능 이전에 쓰인 행에는 없다 */
        note?: string
        noteUpdatedAt?: string
      }
    >(STORES.wordStates),
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
    wordStates: wordStates.map((r) => ({
      languageCode: r.languageCode,
      lemma: r.lemma,
      status: r.status,
      seenCount: r.seenCount,
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
      // 없던 것을 있다고 말하지 않는다
      favorite: r.favorite ?? false,
      favoriteUpdatedAt: r.favoriteUpdatedAt ?? r.lastSeenAt,
      starAngle: r.starAngle ?? 0,
      starColor: r.starColor ?? STAR_COLOR_DEFAULT,
      // 없던 것을 있다고 말하지 않는다 — 이 열이 생기기 전의 행은 0 이다
      knownPresses: r.knownPresses ?? 0,
      unsurePresses: r.unsurePresses ?? 0,
      unknownPresses: r.unknownPresses ?? 0,
      // null/undefined 는 '고친 적 없음' 이다 — 상태만 바꾼 기기가 메모를 지우지 않게
      note: r.note,
      noteUpdatedAt: r.noteUpdatedAt,
    })),
    occurrences,
    tombstones,
  }
}

/**
 * 병합 결과를 로컬에 쓴다.
 *
 * **이미 같은 것은 다시 쓰지 않는다.**
 *
 * 동기화는 병합 결과를 통째로 되돌려 쓴다. 그대로 쓰면 매번 모든 문서와 단어 상태를
 * 다시 저장하게 되고, 저장이 곧 '아직 서버에 못 갔다' 는 신호가 되므로 동기화가
 * '밀렸다' 고 영영 알리는 상태에 놓인다 — 실제로는 다 올라간 뒤에도 'Not synced yet'
 * 이 사라지지 않는 원인이었다.
 *
 * 같은 것을 다시 쓰는 일은 없는데, 저장은 조용해야 할 곳에 시끄러웠다.
 */
/**
 * 저장된 것과 같으면 건드리지 않는다 — 조용해야 할 곳에 시끄러움을 두지 않는다.
 */
async function idbPutIfChanged<T>(
  store: (typeof STORES)[keyof typeof STORES],
  value: T,
): Promise<void> {
  const key = idbKeyOf(store, value)
  if (key === undefined) {
    // 동기화가 받은 것을 쓰는 중이다 — 사용자가 저장한 것으로 세지 않는다
    await idbPut(store, value, { silent: true })
    return
  }
  const stored = await idbGet<T>(store, key)
  if (stored !== undefined && JSON.stringify(stored) === JSON.stringify(value)) return
  await idbPut(store, value, { silent: true })
}

/**
 * 저장소의 주키를 만들어 낸다.
 *
 * 문서·폴더는 'id', 단어 상태는 [languageCode, lemma] 다. 저장소가 늘어날 때마다
 * 여기만 늘리면 된다 — 그래야 '같은 것' 을 저장소의 원래 규칙대로 판단할 수 있다.
 */
function idbKeyOf(
  store: (typeof STORES)[keyof typeof STORES],
  value: unknown,
): IDBValidKey | undefined {
  if (store === STORES.documents) return (value as { id?: IDBValidKey }).id
  if (store === STORES.folders) return (value as { id?: IDBValidKey }).id
  if (store === STORES.wordStates) {
    const state = value as { languageCode?: string; lemma?: string }
    return state.languageCode !== undefined && state.lemma !== undefined
      ? [state.languageCode, state.lemma]
      : undefined
  }
  if (store === STORES.documentTombstones) {
    return (value as { documentId?: IDBValidKey }).documentId
  }
  return undefined
}

export async function writeLocal(
  documents: Document[],
  wordStates: WordStateRecord[],
  occurrences: WordOccurrence[],
  folders: Folder[],
  tombstones: DocumentTombstone[] = [],
  /** 이 문서들의 등장 기록은 건드리지 않는다 — 동기화 중에 새로 계산된 것 */
  skipOccurrenceDocuments: ReadonlySet<string> = new Set(),
): Promise<void> {
  await Promise.all([
    ...documents.map((doc) => idbPutIfChanged(STORES.documents, doc)),
    ...folders.map((folder) => idbPutIfChanged(STORES.folders, folder)),
    ...wordStates.map((state) => idbPutIfChanged(STORES.wordStates, state)),
    ...tombstones.map((tombstone) =>
      idbPutIfChanged(STORES.documentTombstones, tombstone),
    ),
  ])

  // 등장 기록은 문서 단위로 갈아끼운다 — 일부만 덮으면 옛 표기가 남는다
  const byDocument = new Map<string, WordOccurrence[]>()
  for (const record of occurrences) {
    const list = byDocument.get(record.documentId)
    if (list) list.push(record)
    else byDocument.set(record.documentId, [record])
  }
  for (const [documentId, rows] of byDocument) {
    if (skipOccurrenceDocuments.has(documentId)) continue
    await replaceOccurrences(documentId, rows)
  }

  // 다른 기기에서 완전 삭제된 문서는 이 기기에서도 지운다 — 묘비가 이긴다
  for (const tombstone of tombstones) {
    await idbDelete(STORES.documents, tombstone.documentId, { silent: true })
    await idbDelete(STORES.documentMeta, tombstone.documentId, { silent: true })
    await replaceOccurrences(tombstone.documentId, [])
  }
}

/**
 * 한 번의 요청으로 오는 행 수.
 *
 * 서버(Supabase/PostgREST)는 한 요청당 이만큼까지만 돌려준다. 여기서 잘린 만큼은
 * **없는 것처럼 보인다** — 실제로는 서버에 있는데 이 기기가 받지 못한 것이다.
 */
const PAGE_SIZE = 1000

/** 안전망 — 넘으면 조용히 자르지 않고 동기화를 실패시킨다 */
const MAX_ROWS = 200_000

type FetchOptions = {
  /** 이 시각 이후(>=)에 서버가 바꾼 행만 */
  since?: string
  sinceColumn?: string
  /** 이 문서들의 등장 기록만 */
  documentIds?: readonly string[]
}

/**
 * 한 사용자의 행을 **끝까지** 읽는다.
 *
 * 순서를 고정하지 않으면 페이지가 겹치거나 빠진다. offset 대신 마지막으로 읽은
 * 값보다 큰 행만 받는다(keyset) — 읽는 도중 다른 기기가 행을 넣어도 건너뛰지 않는다.
 * `order` 열은 반드시 고유해야 한다 (id 등).
 */
async function fetchAll<T>(
  db: SupabaseClient<Database>,
  table:
    | 'user_languages'
    | 'documents'
    | 'document_tombstones'
    | 'folders'
    | 'word_states'
    | 'word_occurrences',
  userId: string,
  order: string,
  columns = '*',
  options: FetchOptions = {},
): Promise<T[]> {
  type PageResult = { data: unknown[] | null; error: { message: string } | null }
  type Ordered = {
    limit: (count: number) => PromiseLike<PageResult>
    gt: (column: string, value: string | number) => {
      limit: (count: number) => PromiseLike<PageResult>
    }
  }
  type Filterable = {
    in: (column: string, values: readonly string[]) => Filterable
    gte: (column: string, value: string) => Filterable
    order: (column: string, opts: { ascending: boolean }) => Ordered
  }

  const rows: T[] = []
  let last: string | number | undefined

  while (true) {
    // 반환 타입은 호출부가 T 로 정한다 — 여긴 '한 사용자의 행을 끝까지 읽는다' 만 한다
    let filterable = (db as never as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (column: string, value: string) => Filterable
        }
      }
    })
      .from(table)
      .select(columns)
      .eq('user_id', userId)

    if (options.documentIds && options.documentIds.length > 0) {
      filterable = filterable.in('document_id', options.documentIds)
    }
    if (options.since !== undefined && options.sinceColumn !== undefined) {
      filterable = filterable.gte(options.sinceColumn, options.since)
    }

    const ordered = filterable.order(order, { ascending: true })

    const result =
      last === undefined
        ? await ordered.limit(PAGE_SIZE)
        : await ordered.gt(order, last).limit(PAGE_SIZE)

    const { data, error } = result
    if (error) throw error

    const page = (data ?? []) as T[]
    rows.push(...page)
    // 한 페이지가 덜 찼으면 끝이다 — 다음 페이지가 없다
    if (page.length < PAGE_SIZE) break

    const lastRow = page[page.length - 1] as Record<string, unknown>
    const next = lastRow[order]
    if (typeof next !== 'string' && typeof next !== 'number') {
      throw new Error(`${table} 의 ${order} 값이 없어 다음 페이지를 읽을 수 없습니다`)
    }
    last = next

    if (rows.length > MAX_ROWS) {
      throw new Error(
        `${table} 이 ${MAX_ROWS}행을 넘어 동기화를 멈췄습니다 — 데이터를 나눠 주세요`,
      )
    }
  }
  return rows
}

/** 서버 워터마크 — 이번에 읽은 행 중 가장 늦은 server_updated_at, 없으면 이전 값 */
function maxServerTimestamp(
  rows: ReadonlyArray<{ server_updated_at?: string }>,
  previous?: string,
): string | undefined {
  let max = previous
  for (const row of rows) {
    const value = row.server_updated_at
    if (!value) continue
    if (max === undefined || Date.parse(value) > Date.parse(max)) max = value
  }
  return max
}

/** 서버에 지금 있는 행 수 — 증분 읽기에서는 받은 행 수가 전체가 아니다 */
async function countRows(
  db: SupabaseClient<Database>,
  table: 'documents' | 'word_states',
  userId: string,
): Promise<number> {
  const result = await (db as never as {
    from: (t: string) => {
      select: (
        columns: string,
        options: { count: 'exact'; head: true },
      ) => {
        eq: (column: string, value: string) => PromiseLike<{
          count: number | null
          error: { message: string } | null
        }>
      }
    }
  })
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
  if (result.error) throw result.error
  return result.count ?? 0
}

/**
 * 서버에서 읽는다.
 *
 * `since` 가 있으면 그 이후에 **서버가** 바꾼 행만, 없으면 전부 읽는다.
 * 등장 기록은 문서 단위다 — 첫 동기화에는 전부, 이후에는 이번에 바뀐 문서 것만
 * 읽는다. 문서의 server_updated_at 은 replace_word_occurrences 에서도 올라간다.
 */
export async function pull(
  userId: string,
  db: SupabaseClient<Database> = client(),
  since: PullWatermarks = {},
) {
  const [languageRows, documents, tombstones, folders, wordStates, totals] = await Promise.all([
    fetchAll<{ language_code: string }>(db, 'user_languages', userId, 'language_code', 'language_code'),
    fetchAll<DocumentRow>(db, 'documents', userId, 'id', '*', {
      since: since.documents,
      sinceColumn: 'server_updated_at',
    }),
    fetchAll<DocumentTombstoneRow>(db, 'document_tombstones', userId, 'document_id', '*', {
      since: since.tombstones,
      sinceColumn: 'server_updated_at',
    }),
    fetchAll<FolderRow>(db, 'folders', userId, 'id', '*', {
      since: since.folders,
      sinceColumn: 'server_updated_at',
    }),
    fetchAll<WordStateRow>(db, 'word_states', userId, 'id', '*', {
      since: since.wordStates,
      sinceColumn: 'server_updated_at',
    }),
    Promise.all([
      countRows(db, 'documents', userId),
      countRows(db, 'word_states', userId),
    ]).then(([documentCount, wordCount]) => ({
      documents: documentCount,
      wordStates: wordCount,
    })),
  ])

  let occurrences: OccurrenceRow[] = []
  if (since.documents === undefined) {
    // 첫 동기화 — 계정의 등장 기록을 모두 읽는다
    occurrences = await fetchAll<OccurrenceRow>(db, 'word_occurrences', userId, 'id')
  } else {
    const changedDocumentIds = documents.map((row) => row.id)
    for (const part of chunk(changedDocumentIds, 50)) {
      occurrences.push(
        ...(await fetchAll<OccurrenceRow>(db, 'word_occurrences', userId, 'id', '*', {
          documentIds: part,
        })),
      )
    }
  }

  return {
    languages: languageRows.map((r) => r.language_code),
    documents: documents.map(documentFromRow),
    tombstones: tombstones.map(documentTombstoneFromRow),
    folders: folders.map(folderFromRow),
    wordStates: wordStates.map(wordStateFromRow),
    occurrences,
    totals,
    watermarks: {
      documents: maxServerTimestamp(documents, since.documents),
      folders: maxServerTimestamp(folders, since.folders),
      wordStates: maxServerTimestamp(wordStates, since.wordStates),
      tombstones: maxServerTimestamp(tombstones, since.tombstones),
    },
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
  pushedAt,
}: {
  userId: string
  /** 이 기기에서 배운 언어 */
  languages: string[]
  db?: SupabaseClient<Database>
  /** 서버 워터마크 — 없으면 전체를 읽는다 */
  since?: PullWatermarks
  /** 이 로컬 시각 이후에 바뀐 행만 보낸다. 없으면 전부 보낸다 */
  pushedAt?: string
}): Promise<SyncReport> {
  // 이 시각 이후에 이 기기에서 다시 계산된 등장 기록은 이번 동기화가 덮어쓰지 않는다
  const syncStartedAt = new Date().toISOString()
  const [remote, local] = await Promise.all([pull(userId, db, since), readLocal()])

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
      .map((id) => ({ documentId: id, purgedAt: new Date(0).toISOString() })),
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
  const metaRows = await idbGetAll<{
    documentId: string
    lemmaVersion: number
    occurrencesUpdatedAt?: string
  }>(STORES.documentMeta).catch(
    () => [] as { documentId: string; lemmaVersion: number; occurrencesUpdatedAt?: string }[],
  )
  const recomputed = new Set(
    metaRows.filter((m) => m.lemmaVersion === LEMMA_VERSION).map((m) => m.documentId),
  )

  /**
   * 증분 동기화에서 서버가 바뀐 문서는 등장 기록도 **통째로** 교체한다.
   * 로컬에서 다시 계산한 문서는 로컬이 이긴다 — 서버의 옛 표기 기록을 받지 않는다.
   */
  const remoteDocumentIds = new Set(remote.documents.map((row) => row.id))
  const incremental = since?.documents !== undefined
  const replaceDocuments = incremental
    ? new Set([...remoteDocumentIds].filter((id) => !recomputed.has(id)))
    : new Set<string>()

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
  const latestMeta = await idbGetAll<{
    documentId: string
    occurrencesUpdatedAt?: string
  }>(STORES.documentMeta).catch(
    () => [] as { documentId: string; occurrencesUpdatedAt?: string }[],
  )
  const changedDuringSync = new Set(
    latestMeta
      .filter(
        (m) =>
          m.occurrencesUpdatedAt !== undefined &&
          Date.parse(m.occurrencesUpdatedAt) > Date.parse(syncStartedAt),
      )
      .map((m) => m.documentId),
  )

  await writeLocal(
    mergedDocuments,
    mergedWords,
    occurrences,
    folders,
    tombstones,
    changedDuringSync,
  )

  /**
   * 이번에 보낼 것 — **마지막 성공한 동기화 이후에 이 기기에서 바뀐 것만**.
   *
   * 증분 읽기에서는 서버에서 받지 않은 행이 로컬에만 있는 것처럼 보인다. 그 행을
   * 전부 다시 올리면 증분의 의미가 없고, 문서 전문을 매번 올리게 된다.
   */
  const pushedAtMs = pushedAt === undefined ? undefined : Date.parse(pushedAt)
  const touchedAfter = (iso: string | undefined): boolean => {
    if (pushedAtMs === undefined) return true
    if (!iso) return false
    const at = Date.parse(iso)
    return !Number.isNaN(at) && at > pushedAtMs
  }
  const wordTouched = (word: WordStateRecord): boolean => {
    if (pushedAtMs === undefined) return true
    return [word.lastSeenAt, word.favoriteUpdatedAt, word.noteUpdatedAt].some(
      (iso) => iso !== undefined && Date.parse(iso) > pushedAtMs,
    )
  }

  const wordsToPush = words.pushOnly.filter(wordTouched)

  const remoteById = new Map(remoteDocs.map((d) => [d.id, d]))
  const documentsToPush = mergedDocuments.filter((doc) => {
    // 이 기기에서 마지막 동기화 이후 바뀐 문서만 — 나머지는 다시 올리지 않는다.
    // 폴더 이동은 updatedAt 을 건드리지 않고 folderUpdatedAt 만 찍는다.
    if (!touchedAfter(doc.updatedAt) && !touchedAfter(doc.folderUpdatedAt)) return false
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
  const dirtyOccurrenceDocs = new Set(
    pushedAtMs === undefined
      ? local.occurrences.map((record) => record.documentId)
      : metaRows
          .filter(
            (m) =>
              m.occurrencesUpdatedAt !== undefined &&
              Date.parse(m.occurrencesUpdatedAt) > pushedAtMs,
          )
          .map((m) => m.documentId),
  )
  const changedFetched = changedOccurrenceDocuments(
    occurrences,
    remote.occurrences,
    incremental ? remoteDocumentIds : undefined,
  )
  const occurrencePush = [...new Set([...changedFetched, ...dirtyOccurrenceDocs])].filter(
    (id) => isLive(id) && !changedDuringSync.has(id),
  )

  /**
   * 폴더는 문서보다 **먼저** 간다 — 문서의 folder_id 가 폴더를 가리키므로(FK),
   * 폴더가 아직 없는 채로 문서가 가면 서버가 거절한다. 문서가 맞아 떨어지기
   * 전에 자리를 먼저 만들어 두는 것이다.
   */
  const foldersToPush = changedFolders(folders, remote.folders).filter((folder) =>
    touchedAfter(folder.updatedAt),
  )

  // 상태·문서·폴더를 먼저 보낸다 — 진도가 문서에 지면 안 된다
  await push({
    userId,
    db,
    languages,
    documents: documentsToPush,
    words: wordsToPush,
    folders: foldersToPush,
    tombstones,
  })

  /**
   * 등장 기록도 **달라진 문서만** 보낸다.
   *
   * 예전에는 호출부가 이 기기의 모든 기록을 필터 없이 보냈다. 그러면 동기화마다
   * 서버의 등장 기록 전체가 이 기기의 것으로 갈아치워지고, 한 기기의 기록이
   * 덜 계산되어 있으면 서버 전체가 그 기록으로 덮인다.
   */
  await pushOccurrences(userId, occurrences, db, occurrencePush)

  return {
    // 지운 것은 '보낸 단어' 가 아니다 — 서버에서 지운 것이지 보낸 것이 아니다
    pushed: wordsToPush.filter((w) => w.status !== undefined).length,
    pulled: words.pullOnly.length,
    documents: mergedDocuments.length,
    languages,
    watermarks: remote.watermarks,
    serverWords: remote.totals.wordStates,
    serverDocuments: remote.totals.documents,
    /**
     * **이번 사이클을 마친 뒤** 이 기기에 있는 수.
     *
     * 받기 전 숫자를 그대로 쓰면, 새 기기가 단어 2500개를 받은 직후에도
     * '서버 2500 / 이 기기 0' 이라고 말한다 — 실제로는 방금 다 받았다. 숫자가
     * 상황을 설명하지 않으면 숫자를 믿는 사람이 아무것도 모른다.
     */
    localWords: mergedWords.length,
    occurrencePush,
  }
}

/**
 * 문서 묘비 합치기 — 삭제는 되돌릴 수 없으므로 한 번이라도 지웠으면 남긴다.
 * 같은 문서를 두 기기에서 지웠다면 이른 시각을 쓴다.
 */
export function mergeTombstones(
  local: DocumentTombstone[],
  remote: DocumentTombstone[],
): DocumentTombstone[] {
  const byId = new Map<string, DocumentTombstone>()
  for (const tombstone of [...local, ...remote]) {
    const existing = byId.get(tombstone.documentId)
    if (!existing) {
      byId.set(tombstone.documentId, tombstone)
      continue
    }
    if (Date.parse(tombstone.purgedAt) < Date.parse(existing.purgedAt)) {
      byId.set(tombstone.documentId, tombstone)
    }
  }
  return [...byId.values()]
}

/** 문서는 id 로 갈아끼운다 — 마지막으로 고친 쪽이 이긴다 */
export function mergeDocuments(local: Document[], remote: Document[]): Document[] {
  const byId = new Map(remote.map((d) => [d.id, d]))
  for (const doc of local) {
    const theirs = byId.get(doc.id)
    if (!theirs) {
      byId.set(doc.id, doc)
      continue
    }
    /**
     * 문서 내용은 '마지막으로 고친(열은)' 쪽이 이긴다. 폴더는 그보다
     * **언제 옮겼는가**로 따로 이긴다 — 오래 전에 열Pi는 문서를 방금 옮긴
     * 기록이 열기의 무게로 잡혀 먹히면 안 되므로 두 인장을 따로 본다.
     */
    const winner = isNewer(doc.updatedAt, theirs.updatedAt) ? doc : theirs
    const folderWinner = folderWinnerOf(doc, theirs)
    if (winner === folderWinner) byId.set(doc.id, winner)
    else byId.set(doc.id, { ...winner, folderId: folderWinner.folderId ?? null, folderUpdatedAt: folderWinner.folderUpdatedAt })
  }
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/**
 * 두 기록 가운데 폴더를 늦게 옮긴 쪽.
 *
 * 인장도 없는 옛 기록(폴더 기능 이전의 행)은 '없음' 이다 — 둘 다 인장이 없으면
 * 아무런 폴더 기록이 없는 것이고, 폴더에 없는 결과가 남는다. 한쪽에만 있으면
 * 그쪽이 이긴다.
 */
function folderWinnerOf(a: Document, b: Document): Document {
  const aStamp = a.folderUpdatedAt
  const bStamp = b.folderUpdatedAt
  // 둘 다 인장이 없으면 폴더 기록 자체가 없는 것이다 — 폴더에 없다고 남는다
  if (!aStamp && !bStamp) return { ...a, folderId: null, folderUpdatedAt: undefined }
  if (!bStamp) return a
  if (!aStamp) return b
  return isNewer(aStamp, bStamp) ? a : b
}


/**
 * 서버에 없는 것만 보낸다.
 *
 * 전부 다시 보내면 RLS 통과는 하지만 다른 기기의 변경과 부딪힐 수 있고,
 * 불필요한 쓰기로更新时间가 어긋난다.
 */
/**
 * 서버로 보낸다.
 *
 * **표마다 독립적으로 보내고, 진도를 가장 먼저 보낸다.**
 *
 * 예전엔 언어 → 문서 → 단어 상태 순서로 한 번에 보내고, 앞이 실패하면 뒤를 아예
 * 실행하지 않았다. 문서 한 줄이 서버 규칙에 걸리면 **사용자가 직접 고른 단어 상태가
 * 서버로 나가지 않았다.** 기기 안에만 남고, 다른 기기는 서버의 옛 상태를 받아 본다.
 * 사용자가 보는 증상은 '이 기기만 최신이고 나머지는 옛것' 이었다.
 *
 * 진도가 문서에 지는 일은 없어야 한다. 실패한 표가 있으면 모아서 한 번에 알린다 —
 * 조용히 삼키면 무엇이 안 갔는지 알 방법이 없다.
 */
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

/** 한 줄의 내용을 한 문자열로 — 표기만이 아니라 문장·위치·횟수까지 본다 */
function occurrenceKey(
  lemma: string,
  surface: string,
  charStart: number,
  charEnd: number,
  sentence: string,
  count: number,
): string {
  return `${lemma}\u0000${surface}\u0000${charStart}\u0000${charEnd}\u0000${sentence}\u0000${count}`
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
      occurrenceKey(
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
        occurrenceKey(
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
 * 폴더는 id 로 갈아끼운다 — 문서와 같은 규칙이다.
 *
 * 톰스톤도 같은 자리로 온다. 지운 폴더의 updated_at 이 늦으면 그 지움이 이기고,
 * 옛 폴더가 되살아나지 않는다 (문서 휴지통 상태가 같은 방식으로 병합된다).
 *
 * 폴더에는 서버 트리거가 없다 — updated_at 을 우리가 찍어서 보내므로, 이
 * 병합은 클라이언트 인장을 그대로 믿는다.
 */
export function mergeFolders(local: Folder[], remote: Folder[]): Folder[] {
  const byId = new Map(remote.map((f) => [f.id, f]))
  for (const folder of local) {
    const theirs = byId.get(folder.id)
    if (!theirs) {
      byId.set(folder.id, folder)
      continue
    }
    if (!isNewer(folder.updatedAt, theirs.updatedAt)) {
      // 인장이 같은데 내용이 다르면 (지움 vs 고침) 지움을 믿는다 —
      // 되살려 놓는 실수보다 지운 채로 남는 쪽이 조용하다
      const tieGoesToTombstone = Boolean(folder.deletedAt && !theirs.deletedAt)
      byId.set(folder.id, tieGoesToTombstone ? folder : theirs)
      continue
    }
    byId.set(folder.id, folder)
  }
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
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

/**
 * 한 요청에 담을 행 수. 큰 단어장에서도 요청 본문이 서버 한도를 넘지 않게 나눈다.
 * 문서는 한 행이 클 수 있어 더 작게 나눈다.
 */
const WRITE_CHUNK = 500
const DOCUMENT_CHUNK = 100

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

/**
 * **폴더가 문서보다 먼저 가는 것이 서버의 규칙이다** — 문서의 folder_id 가
 * 폴더를 가리키므로(FK) 폴더가 아직 없으면 문서가 거절된다.
 */

export async function push({
  userId,
  db,
  languages,
  documents,
  words,
  folders,
  tombstones,
}: {
  userId: string
  db: SupabaseClient<Database>
  languages: string[]
  documents: Document[]
  words: WordStateRecord[]
  folders: Folder[]
  tombstones: DocumentTombstone[]
}): Promise<void> {
  const failures: string[] = []

  type SendResult = { error: { message: string } | null }
  const send = async (table: string, run: () => PromiseLike<SendResult>) => {
    try {
      const { error } = await run()
      if (error) failures.push(`${table}: ${error.message}`)
    } catch (error) {
      failures.push(`${table}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 묘비 먼저 — 문서가 실패해도 '지웠다' 는 사실은 나가야 한다
  for (const part of chunk(tombstones, WRITE_CHUNK)) {
    await send('document_tombstones', () =>
      db
        .from('document_tombstones')
        .upsert(part.map((tombstone) => documentTombstoneToRow(userId, tombstone)), {
          onConflict: 'user_id,document_id',
        }),
    )
  }
  // 지운 문서는 서버에서도 지운다 — 오프라인에서 실패했어도 다음 동기화가 재시도한다
  for (const part of chunk(tombstones.map((tombstone) => tombstone.documentId), 100)) {
    await send('documents', () =>
      db.from('documents').delete().eq('user_id', userId).in('id', part),
    )
  }

  // 진도 먼저 — 문서가 실패해도 이것은 나가야 한다.
  // 없앤 표시도 status = null 인 행으로 올린다. 행을 지우면 즐겨찾기·메모·횟수가
  // 서버에서 사라지고, 다른 기기가 옛 상태를 다시 올려 없앰과 되살림이 번갈아 일어난다.
  for (const part of chunk(words, WRITE_CHUNK)) {
    await send('word_states', () =>
      db
        .from('word_states')
        .upsert(part.map((w) => wordStateToRow(userId, w)), {
          onConflict: 'user_id,language_code,lemma',
        }),
    )
  }

  /**
   * 폴더 먼저 — 문서의 folder_id 가 폴더를 가리키므로(FK) 문서보다 앞서야 한다.
   * 실패가 있으면 모아서 한 번에 알린다 — 조용히 삼키면 무엇이 안 갔는지 알 방법이 없다.
   */
  for (const part of chunk(folders, WRITE_CHUNK)) {
    await send('folders', () =>
      db.from('folders').upsert(part.map((folder: Folder) => folderToRow(userId, folder)), {
        onConflict: 'id',
      }),
    )
  }

  for (const part of chunk(documents, DOCUMENT_CHUNK)) {
    await send('documents', () =>
      db.from('documents').upsert(part.map((doc) => documentToRow(userId, doc)), { onConflict: 'id' }),
    )
  }

  for (const part of chunk(languages, WRITE_CHUNK)) {
    await send('user_languages', () =>
      db
        .from('user_languages')
        .upsert(
          part.map((language_code) => ({ user_id: userId, language_code })),
          { onConflict: 'user_id,language_code', ignoreDuplicates: true },
        ),
    )
  }

  if (failures.length > 0) {
    throw new Error(`서버 저장 실패 — ${failures.join(' / ')}`)
  }
}

/** 등장 기록은 문서를 통째로 다시 보낸다 — 일부만 갱신하면 옛 표기가 남는다 */
/**
 * 등장 기록을 문서 단위로 통째로 보낸다 — 일부만 갱신하면 옛 표기가 남는다.
 *
 * `onlyDocumentIds` 를 주면 **그 문서만** 보낸다. 아무 것도 안 주면 보낸다.
 *
 * 이 제한이 없으면 문제가 크다 — 아래 주석.
 */
export async function pushOccurrences(
  _userId: string,
  records: WordOccurrence[],
  db: SupabaseClient<Database> = client(),
  onlyDocumentIds?: readonly string[],
): Promise<void> {
  if (records.length === 0) return

  const localDocumentIds = new Set(records.map((record) => record.documentId))
  const documentIds = onlyDocumentIds
    ? onlyDocumentIds.filter((id) => localDocumentIds.has(id))
    : [...localDocumentIds]
  if (documentIds.length === 0) return

  const byDocument = new Map<string, WordOccurrence[]>()
  for (const record of records) {
    if (!documentIds.includes(record.documentId)) continue
    const list = byDocument.get(record.documentId)
    if (list) list.push(record)
    else byDocument.set(record.documentId, [record])
  }

  /**
   * 문서 하나를 **한 트랜잭션에서** 갈아끼운다.
   *
   * delete 와 insert 를 따로 보내면 중간 실패에 기록이 비거나, 동시에 쓴 다른
   * 기기의 행과 겹친다. 서버 함수가 지우기와 넣기를 함께 한다.
   */
  for (const [documentId, local] of byDocument) {
    const rows = local.flatMap((record) =>
      record.surfaces.map((surface) => ({
        language_code: record.languageCode,
        lemma: record.lemma,
        surface,
        char_start: record.charStart,
        char_end: record.charEnd,
        sentence: record.sentence,
        occurrences_count: record.count,
      })),
    )

    const { error } = await db.rpc('replace_word_occurrences', {
      p_document_id: documentId,
      p_rows: rows,
    })
    if (error) throw error
  }
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
