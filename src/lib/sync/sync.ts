import type { SupabaseClient } from '@supabase/supabase-js'

import { STORES, idbGet, idbGetAll, idbPut, replaceOccurrences } from '../storage/localDb'
import { mergeOccurrences } from './mergeOccurrences'
import { purgedDocumentIds } from '../storage/purged'
import { LEMMA_VERSION } from '../../features/reader/surfaceLemma'
import { supabase } from '../supabase/client'
import type { Database } from '../supabase/database.types'
import type { Document, Folder, WordStatus } from '../../types'
import type { WordOccurrence } from '../../app/stores/occurrences'
import { STAR_COLOR_DEFAULT } from '../../app/stores/settings'
import { isNewer, mergeLanguages, mergeWordStates, type WordStateRecord } from './merge'
import {
  documentFromRow,
  documentToRow,
  folderFromRow,
  folderToRow,
  occurrenceToRows,
  wordStateFromRow,
  wordStateToRow,
  type DocumentRow,
  type FolderRow,
  type OccurrenceRow,
  type WordStateRow,
} from './mapping'

export type SyncStatus = 'local' | 'syncing' | 'synced' | 'error'

export type SyncReport = {
  pushed: number
  pulled: number
  documents: number
  /** 병합된 배운 언어 — 호출한 쪽이 이 기기에 채택해야 한다 */
  languages: string[]
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
}> {
  const [documents, folders, wordStates, occurrences] = await Promise.all([
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
  return undefined
}

export async function writeLocal(
  documents: Document[],
  wordStates: WordStateRecord[],
  occurrences: WordOccurrence[],
  folders: Folder[],
): Promise<void> {
  await Promise.all([
    ...documents.map((doc) => idbPutIfChanged(STORES.documents, doc)),
    ...folders.map((folder) => idbPutIfChanged(STORES.folders, folder)),
    ...wordStates.map((state) => idbPutIfChanged(STORES.wordStates, state)),
  ])

  // 등장 기록은 문서 단위로 갈아끼운다 — 일부만 덮으면 옛 표기가 남는다
  const byDocument = new Map<string, WordOccurrence[]>()
  for (const record of occurrences) {
    const list = byDocument.get(record.documentId)
    if (list) list.push(record)
    else byDocument.set(record.documentId, [record])
  }
  for (const [documentId, rows] of byDocument) {
    await replaceOccurrences(documentId, rows)
  }
}

/**
 * 한 번의 요청으로 오는 행 수.
 *
 * 서버(Supabase/PostgREST)는 한 요청당 이만큼까지만 돌려준다. 여기서 잘린 만큼은
 * **없는 것처럼 보인다** — 실제로는 서버에 있는데 이 기기가 받지 못한 것이다.
 */
const PAGE_SIZE = 1000

/** 안전망 — 페이지를无数히 받지 않도록 */
const MAX_ROWS = 200_000

/**
 * 한 사용자의 행을 **끝까지** 읽는다.
 *
 * 순서를 고정하지 않으면 페이지를 나눠 읽을 때 행이 중복되거나 건너뛴다 — 서버가 정해 둔
 * 순서는 보장되지 않으므로, '다음 1000개' 가 무엇인지를 우리가 정해야 한다.
 */
async function fetchAll<T>(
  db: SupabaseClient<Database>,
  table: 'user_languages' | 'documents' | 'folders' | 'word_states' | 'word_occurrences',
  userId: string,
  order: string,
  columns = '*',
): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    // 반환 타입은 호출부가 T 로 정한다 — 여긴 '한 사용자의 행을 끝까지 읽는다' 만 한다
    const result = await (db as never as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (column: string, value: string) => {
            order: (column: string, opts: { ascending: boolean }) => {
              range: (from: number, to: number) => PromiseLike<{
                data: unknown[] | null
                error: { message: string } | null
              }>
            }
          }
        }
      }
    })
      .from(table)
      .select(columns)
      .eq('user_id', userId)
      .order(order, { ascending: true })
      .range(from, from + PAGE_SIZE - 1)

    const { data, error } = result as { data: unknown[] | null; error: { message: string } | null }
    if (error) throw error
    rows.push(...((data ?? []) as T[]))
    // 한 페이지가 덜 찼으면 끝이다 — 다음 페이지가 없다
    if ((data ?? []).length < PAGE_SIZE) break
  }
  return rows
}

export async function pull(userId: string, db: SupabaseClient<Database> = client()) {
  /**
   * 모든 표를 끝까지 읽는다.
   *
   * 예전엔 한 번씩만 읽었다. 서버는 한 요청당 1000행까지만 주므로, **1000개를 넘는
   * 단어 상태는 이 기기로 영영 오지 않았다.** 화면에는 '서버에 1000개' 라고Shows —
   * 실제로는 그 이상인데 잘린 것이었다. 그 숫자를 믿은 나는 '서버에 다 있다' 고
   * 잘못 읽었다.
   */
  const [languageRows, documents, folders, wordStates, occurrences] = await Promise.all([
    fetchAll<{ language_code: string }>(db, 'user_languages', userId, 'language_code', 'language_code'),
    fetchAll<DocumentRow>(db, 'documents', userId, 'id'),
    fetchAll<FolderRow>(db, 'folders', userId, 'id'),
    fetchAll<WordStateRow>(db, 'word_states', userId, 'id'),
    fetchAll<OccurrenceRow>(db, 'word_occurrences', userId, 'id'),
  ])

  return {
    languages: languageRows.map((r) => r.language_code),
    documents: documents.map(documentFromRow),
    folders: folders.map(folderFromRow),
    wordStates: wordStates.map(wordStateFromRow),
    occurrences: occurrences as OccurrenceRow[],
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
}: {
  userId: string
  /** 이 기기에서 배운 언어 */
  languages: string[]
  db?: SupabaseClient<Database>
}): Promise<SyncReport> {
  const [remote, local] = await Promise.all([pull(userId, db), readLocal()])

  const words = mergeWordStates(local.wordStates, remote.wordStates)
  const languages = mergeLanguages(localLanguages, remote.languages)
  const folders = mergeFolders(local.folders, remote.folders)

  /**
   * 이 기기에서 완전 삭제한 문서는 서버 것이 남아 있어도 받지 않는다.
   *
   * 삭제 요청과 이 조회가 겹치면 지운 문서가 그대로 내려온다. 병합은 그걸 되살리고,
   * 다음 동기화는 되살아난 것을 서버에 다시 올린다 — 지운 문서가 영구히 되돌아온다.
   */
  const purged = purgedDocumentIds()
  const liveRemote = remote.documents.filter((d) => !purged.includes(d.id))
  const liveOccurrences = remote.occurrences.filter((o) => !purged.includes(o.document_id))
  const remoteDocs = liveRemote

  /**
   * 이 기기에서 **현재 규칙으로 다시 계산한** 문서.
   *
   * 서버에 옛 표기 규칙이 만든 기록이 남아 있고, 동기화는 그것을 매번 다시 넣어준다.
   * 새 규칙에서 나오지 않는 키는 같은 키로 덮어써지지 않으므로 살아남는다 — 목록과
   * 본문이 서로 다른 진도를 보인다 (mergeOccurrences.ts).
   */
  const meta = await idbGetAll<{ documentId: string; lemmaVersion: number }>(STORES.documentMeta)
    .catch(() => [] as { documentId: string; lemmaVersion: number }[])
  const recomputed = new Set(
    meta.filter((m) => m.lemmaVersion === LEMMA_VERSION).map((m) => m.documentId),
  )

  const occurrences = mergeOccurrences(
    local.occurrences,
    liveOccurrences,
    recomputed,
    [...local.documents, ...remoteDocs],
    new Set(purged),
  )

  const mergedDocuments = mergeDocuments(local.documents, remoteDocs)
    // 로컬에 남은 지운 문서가 있어도 서버로 다시 올리지 않는다
    .filter((d) => !purged.includes(d.id))
  // 없앤 표시도 status = null 인 행으로 남긴다 — 행 자체가 즐겨찾기·메모·횟수를 든다
  const mergedWords = words.merged

  await writeLocal(mergedDocuments, mergedWords, occurrences, folders)

  /**
   * 바뀐 문서만 보낸다.
   *
   * 전부 다시 보내면 안 된다. upsert 는 기존 행에 UPDATE 를 걸고, 서버의
   * set_updated_at 트리거가 updated_at 을 now() 로 다시 찍는다. 한 번 동기화할 때
   * 보낸 모든 문서의 '최근 본 시각' 이 같은 시각이 되어, 목록의 날짜가 전부
   * 같아지고 정렬도 무의미해진다. 실제로 그랬다.
   */
  const remoteById = new Map(remoteDocs.map((d) => [d.id, d]))
  const documentsToPush = mergedDocuments.filter((doc) => {
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
   * 등장 기록은 **달라진 문서만** 보낸다.
   *
   * 예전엔 이 기기의 기록을 문서 단위로 통째로 지우고 다시 넣었다. 한 번 동기화할 때마다
   * 서버의 모든 등장 기록이 이 기기의 것으로 교체된다.
   *
   * 그 결과가Coc Jordan 보이는 것이었다 — 어느 기기의 기록이 덜 계산되어 있으면 그것이
   * 서버 전체를 덮어쓴다. 그래서 **단어 색깔(`byKey`)은 맞는��**데 **목록 게이지와
   * 단어장은 다른 기기의 것을 잃었다** — 게이지와 단어장은 기록에서 나오고 색깔은
   * 상태에서 나오기 때문이다.
   *
   * 같으면 보내지 않는다. 기록은 문서를 열 때 다시 쓰이므로, 바뀐 것만 보내면 충분하다.
   */
  const occurrencePush = changedOccurrenceDocuments(occurrences, remote.occurrences)

  /**
   * 폴더는 문서보다 **먼저** 간다 — 문서의 folder_id 가 폴더를 가리키므로(FK),
   * 폴더가 아직 없는 채로 문서가 가면 서버가 거절한다. 문서가 맞아 떨어지기
   * 전에 자리를 먼저 만들어 두는 것이다.
   */
  const foldersToPush = changedFolders(folders, remote.folders)

  // 상태·문서·폴더를 먼저 보낸다 — 진도가 문서에 지면 안 된다
  await push({ userId, db, languages, documents: documentsToPush, words: words.pushOnly, folders: foldersToPush })

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
    pushed: words.pushOnly.filter((w) => w.status !== undefined).length,
    pulled: words.pullOnly.length,
    documents: mergedDocuments.length,
    languages,
    serverWords: remote.wordStates.length,
    serverDocuments: remote.documents.length,
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
}: {
  userId: string
  db: SupabaseClient<Database>
  languages: string[]
  documents: Document[]
  words: WordStateRecord[]
  folders: Folder[]
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
  userId: string,
  records: WordOccurrence[],
  db: SupabaseClient<Database> = client(),
  onlyDocumentIds?: readonly string[],
): Promise<void> {
  if (records.length === 0) return

  const allDocumentIds = [...new Set(records.map((r) => r.documentId))]
  const documentIds = onlyDocumentIds
    ? allDocumentIds.filter((id) => onlyDocumentIds.includes(id))
    : allDocumentIds
  if (documentIds.length === 0) return

  // 지우기도 나눈다 — 문서 id 가 많으면 요청이 길어진다
  for (const part of chunk(documentIds, 100)) {
    const { error } = await db
      .from('word_occurrences')
      .delete()
      .eq('user_id', userId)
      .in('document_id', part)
    if (error) throw error
  }

  const rows = records
    .filter((record) => documentIds.includes(record.documentId))
    .flatMap((record) => occurrenceToRows(userId, record))
  if (rows.length === 0) return
  // 서버는 표기 하나당 한 줄이라 묶음 제한을 넘지 않도록 잘라 보낸다
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from('word_occurrences').insert(rows.slice(i, i + 500))
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
