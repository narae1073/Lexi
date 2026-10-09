import type { Database } from '../supabase/database.types'
import type { Document, LanguageCode, WordStatus } from '../../types'
import type { WordOccurrence } from '../../app/stores/occurrences'
import type { WordStateRecord } from './merge'

/**
 * 로컬 ↔ 서버 행 변환.
 *
 * 두 모양이 꽤 다르다 — 로컬 camelCase + ISO 문자열, 서버 snake_case + timestamptz.
 * 이 변환만 한 곳에 모아 두면 스키마가 바뀌어도 여기만 고치면 된다.
 */

export type WordStateRow = Database['public']['Tables']['word_states']['Row']
export type DocumentRow = Database['public']['Tables']['documents']['Row']
export type OccurrenceRow = Database['public']['Tables']['word_occurrences']['Row']

/**
 * 서버에 보낼 때는 Insert 모양(자동 채번 열 없음)으로 만든다.
 *
 * upsert 의 payload 에 id 를 넣으면, 기존 행이 갱신될 때 그 자리에 쓰인 값으로
 * id 가 덮인다. 고정된 더미 uuid 를 넣으면 서로 다른 단어가 같은 id 를 차지해
 * 기본키가 부딪힌다.
 */
type WordStateInsert = Database['public']['Tables']['word_states']['Insert']
type OccurrenceInsert = Database['public']['Tables']['word_occurrences']['Insert']

export type OccurrenceGroup = { documentId: string; lemma: string; rows: OccurrenceKey[] }

/** 읽을 때 필요한 열만 — Row 와 Insert 를 모두 받으려면 이만큼이면 된다 */
/**
 * 읽을 때 필요한 열만.
 *
 * occurrences_count 는 서버 기본값이 있으므로 없을 수도 있다 — 마이그레이션
 * 이전에 쓰인 행, 그리고 값을 싣지 않은 insert 모두 이 경우다. 없으면 1 이다.
 */
type OccurrenceKey = Pick<
  OccurrenceRow,
  'document_id' | 'language_code' | 'lemma' | 'surface' | 'char_start' | 'char_end' | 'sentence'
> & { occurrences_count?: number }

const statusToServer = (status: WordStatus): Database['public']['Enums']['word_status'] => status
const statusFromServer = (status: WordStateRow['status']): WordStatus => status

export function wordStateToRow(
  userId: string,
  record: WordStateRecord & { status: WordStatus },
): WordStateInsert {
  return {
    user_id: userId,
    language_code: record.languageCode,
    lemma: record.lemma,
    status: statusToServer(record.status),
    seen_count: record.seenCount,
    first_seen_at: record.firstSeenAt,
    last_seen_at: record.lastSeenAt,
    is_favorite: record.favorite,
    favorite_updated_at: record.favoriteUpdatedAt,
    star_angle: record.starAngle,
    star_color: record.starColor,
  }
}

export function wordStateFromRow(row: WordStateRow): WordStateRecord & { status: WordStatus } {
  return {
    languageCode: row.language_code,
    lemma: row.lemma,
    status: statusFromServer(row.status),
    seenCount: row.seen_count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    // 마이그레이션 이전 행에는 서버 기본값이 들어 있다
    favorite: row.is_favorite ?? false,
    favoriteUpdatedAt: row.favorite_updated_at ?? row.last_seen_at,
    starAngle: row.star_angle ?? 0,
    starColor: row.star_color ?? '#eab308',
  }
}

export function documentToRow(userId: string, doc: Document): DocumentRow {
  return {
    id: doc.id,
    user_id: userId,
    title: doc.title,
    language_code: doc.languageCode,
    raw_text: doc.rawText,
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
    deleted_at: doc.deletedAt ?? null,
  }
}

export function documentFromRow(row: DocumentRow): Document {
  return {
    id: row.id,
    title: row.title,
    languageCode: row.language_code as LanguageCode,
    rawText: row.raw_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null,
  }
}

/**
 * 등장 기록 → 서버 행.
 *
 * 서버는 표기 하나당 한 줄이라 로달의 `surfaces` 를 펼친다.
 * `count` 와 `recordedAt`, `documentTitle` 은 서버에 자리가 없다 —
 * 전부 로컬에서 파생되는 값이라 애초에 서버에 필요 없다.
 * 이 함수가 순수해야만 push 전에 검증할 수 있다.
 */
export function occurrenceToRows(userId: string, record: WordOccurrence): OccurrenceInsert[] {
  const base: Omit<OccurrenceInsert, 'surface'> = {
    user_id: userId,
    document_id: record.documentId,
    language_code: record.languageCode,
    lemma: record.lemma,
    char_start: record.charStart,
    char_end: record.charEnd,
    sentence: record.sentence,
    // 같은 단어의 표기들은 등장 횟수가 같다. 어느 줄에 실어도 무방하다.
    occurrences_count: record.count,
  }
  return record.surfaces.map((surface) => ({ ...base, surface }))
}

/**
 * 서버 행 → 로컬 등장 기록.
 *
 * 등장 횟수는 서버의 occurrences_count 를 쓴다. 같은 (문서, 단어) 그룹의
 * 모든 줄이 같은 값을 갖고 있어 첫 줄만 보면 된다.
 *
 * 옛 행에는 이 열이 없어 기본값 1 이 들어 있다. 그 문서를 열면 다시 계산되어
 * 정확해진다.
 */
export function occurrenceFromRows(rows: OccurrenceKey[], document: Document): WordOccurrence {
  const ordered = [...rows].sort((a, b) => a.char_start - b.char_start)
  const first = ordered[0]
  const last = ordered.at(-1) ?? first

  return {
    documentId: first.document_id,
    languageCode: first.language_code as LanguageCode,
    lemma: first.lemma,
    surfaces: [...new Set(ordered.map((r) => r.surface))],
    count: first.occurrences_count ?? 1,
    recordedAt: Date.parse(document.updatedAt),
    charStart: first.char_start,
    charEnd: last.char_end,
    sentence: first.sentence,
    documentTitle: document.title,
  }
}

/**
 * 등장 기록을 (문서, 단어) 단위로 묶는다.
 *
 * **문서만으로 묶으면 안 된다.** 로컬 기록은 (documentId, lemma) 이 한 행이지만
 * 서버는 표기 하나당 한 줄이라 같은 단어의 표기가 여러 줄로 흩어진다.
 * 문서 단위로만 묶으면 문서 안의 모든 단어가 한 레코드로 뭉개진다 —
 * 첫 줄의 lemma 을representative 로 삼고 나머지 단어는 전부 surfaces 가 된다.
 * 실제로 그렇게 되어, 새 기기에서 단어장이 "1 words" 로 보이던 않았다.
 */
export function groupOccurrences(rows: OccurrenceKey[]): OccurrenceGroup[] {
  const grouped = new Map<string, { documentId: string; lemma: string; rows: OccurrenceKey[] }>()
  for (const row of rows) {
    const key = `${row.document_id}::${row.lemma}`
    const bucket = grouped.get(key)
    if (bucket) bucket.rows.push(row)
    else grouped.set(key, { documentId: row.document_id, lemma: row.lemma, rows: [row] })
  }
  return [...grouped.values()]
}

export type { OccurrenceInsert, OccurrenceKey, WordStateInsert }
