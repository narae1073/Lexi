import type { SupabaseClient } from '@supabase/supabase-js'

import { STORES, idbGet, idbGetAll, idbPut, replaceOccurrences } from '../storage/localDb'
import { mergeOccurrences } from './mergeOccurrences'
import { purgedDocumentIds } from '../storage/purged'
import { LEMMA_VERSION } from '../../features/reader/surfaceLemma'
import { supabase } from '../supabase/client'
import type { Database } from '../supabase/database.types'
import type { Document, WordStatus } from '../../types'
import type { WordOccurrence } from '../../app/stores/occurrences'
import { isNewer, mergeLanguages, mergeWordStates, withStatus, type WordStateRecord } from './merge'
import {
  documentFromRow,
  documentToRow,
  occurrenceToRows,
  wordStateFromRow,
  wordStateToRow,
} from './mapping'

export type SyncStatus = 'local' | 'syncing' | 'synced' | 'error'

export type SyncReport = {
  pushed: number
  pulled: number
  documents: number
  /** 병합된 배운 언어 — 호출한 쪽이 이 기기에 채택해야 한다 */
  languages: string[]
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
  wordStates: (WordStateRecord & { status: WordStatus })[]
  occurrences: WordOccurrence[]
}> {
  const [documents, wordStates, occurrences] = await Promise.all([
    idbGetAll<Document>(STORES.documents),
    idbGetAll<WordStateRecord & { surface?: string; status: WordStatus }>(STORES.wordStates),
    idbGetAll<WordOccurrence>(STORES.wordOccurrences),
  ])

  return {
    documents,
    wordStates: wordStates.map((r) => ({
      languageCode: r.languageCode,
      lemma: r.lemma,
      status: r.status,
      seenCount: r.seenCount,
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
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
    await idbPut(store, value)
    return
  }
  const stored = await idbGet<T>(store, key)
  if (stored !== undefined && JSON.stringify(stored) === JSON.stringify(value)) return
  await idbPut(store, value)
}

/**
 * 저장소의 주키를 만들어 낸다.
 *
 * 문서는 'id', 단어 상태는 [languageCode, lemma] 다. 저장소가 늘어날 때마다 여기만
 * 늘리면 된다 — 그래야 '같은 것' 을 저장소의 원래 규칙대로 판단할 수 있다.
 */
function idbKeyOf(
  store: (typeof STORES)[keyof typeof STORES],
  value: unknown,
): IDBValidKey | undefined {
  if (store === STORES.documents) return (value as { id?: IDBValidKey }).id
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
  wordStates: (WordStateRecord & { status: WordStatus })[],
  occurrences: WordOccurrence[],
): Promise<void> {
  await Promise.all([
    ...documents.map((doc) => idbPutIfChanged(STORES.documents, doc)),
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

export async function pull(userId: string, db: SupabaseClient<Database> = client()) {
  const [languages, documents, wordStates, occurrences] = await Promise.all([
    db.from('user_languages').select('language_code').eq('user_id', userId),
    db.from('documents').select('*').eq('user_id', userId),
    db.from('word_states').select('*').eq('user_id', userId),
    db.from('word_occurrences').select('*').eq('user_id', userId),
  ])

  for (const result of [languages, documents, wordStates, occurrences]) {
    if (result.error) throw result.error
  }

  return {
    languages: (languages.data ?? []).map((r) => r.language_code),
    documents: (documents.data ?? []).map(documentFromRow),
    wordStates: (wordStates.data ?? []).map(wordStateFromRow),
    occurrences: occurrences.data ?? [],
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

  const mergedWords = words.merged.map((record) => withStatus(record))

  await writeLocal(mergedDocuments, mergedWords, occurrences)

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
    // 이 기기에서 더 늦게 열었다
    return isNewer(doc.updatedAt, theirs.updatedAt)
  })

  // 등장 기록은 문서를 열 때 다시 쓰이므로, 이번 사이클에서는 상태와 문서만 보낸다
  await push({ userId, db, languages, documents: documentsToPush, words: words.pushOnly })

  return {
    pushed: words.pushOnly.length,
    pulled: words.pullOnly.length,
    documents: mergedDocuments.length,
    languages,
  }
}

/** 문서는 id 로 갈아끼운다 — 마지막으로 고친 쪽이 이긴다 */
export function mergeDocuments(local: Document[], remote: Document[]): Document[] {
  const byId = new Map(remote.map((d) => [d.id, d]))
  for (const doc of local) {
    const theirs = byId.get(doc.id)
    if (!theirs || isNewer(doc.updatedAt, theirs.updatedAt)) byId.set(doc.id, doc)
  }
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
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
export async function push({
  userId,
  db,
  languages,
  documents,
  words,
}: {
  userId: string
  db: SupabaseClient<Database>
  languages: string[]
  documents: Document[]
  words: WordStateRecord[]
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

  // 진도 먼저 — 문서가 실패해도 이것은 나가야 한다
  if (words.length > 0) {
    await send('word_states', () =>
      db
        .from('word_states')
        .upsert(words.map((w) => wordStateToRow(userId, withStatus(w))), {
          onConflict: 'user_id,language_code,lemma',
        }),
    )
  }

  if (documents.length > 0) {
    await send('documents', () =>
      db.from('documents').upsert(documents.map((doc) => documentToRow(userId, doc)), { onConflict: 'id' }),
    )
  }

  if (languages.length > 0) {
    await send('user_languages', () =>
      db
        .from('user_languages')
        .upsert(
          languages.map((language_code) => ({ user_id: userId, language_code })),
          { onConflict: 'user_id,language_code', ignoreDuplicates: true },
        ),
    )
  }

  if (failures.length > 0) {
    throw new Error(`서버 저장 실패 — ${failures.join(' / ')}`)
  }
}

/** 등장 기록은 문서를 통째로 다시 보낸다 — 일부만 갱신하면 옛 표기가 남는다 */
export async function pushOccurrences(
  userId: string,
  records: WordOccurrence[],
  db: SupabaseClient<Database> = client(),
): Promise<void> {
  if (records.length === 0) return

  const documentIds = [...new Set(records.map((r) => r.documentId))]
  const { error: deleteError } = await db
    .from('word_occurrences')
    .delete()
    .eq('user_id', userId)
    .in('document_id', documentIds)
  if (deleteError) throw deleteError

  const rows = records.flatMap((record) => occurrenceToRows(userId, record))
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
