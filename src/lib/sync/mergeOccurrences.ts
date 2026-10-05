import { groupOccurrences, occurrenceFromRows } from './mapping'
import type { WordOccurrence } from '../../app/stores/occurrences'
import type { Document } from '../../types'

/** 서버의 등장 기록 한 줄 */
export type RemoteOccurrenceRow = {
  document_id: string
  language_code: string
  lemma: string
  surface: string
  char_start: number
  char_end: number
  sentence: string
  occurrences_count: number
}

/**
 * 서버의 등장 기록과 이 기기의 것을 합친다.
 *
 * **내가 지금 규칙으로 다시 계산한 문서는 서버 것을 받지 않는다.**
 *
 * 서버에는 옛 표기 규칙이 만든 기록이 남아 있다. 새 규칙에서 나오지 않는 키(프랑스어
 * 축약 전의 `l'été` 같은)는 같은 키로 덮어써지지 않으므로 살아남고, 매 동기화마다 다시
 * 들어온다. 목록은 그 옛 키를 '옳지 않은 단어' 로 함께 세지만, 본문은 지금 규칙으로
 * 풀어 다른 수를 보인다 — 같은 문서에 두 개의 진도가 생기고 어느 쪽도 틀렸다고 알 수
 * 없다.
 *
 * 되받는 것은 아직 이 기기에서 계산하지 않은 문서뿐이다 — 다른 기기에서 한 일은
 * 그대로 온다.
 */
export function mergeOccurrences(
  local: WordOccurrence[],
  remoteRows: RemoteOccurrenceRow[],
  recomputed: Set<string>,
  documents: Document[],
  purged: Set<string> = new Set(),
): WordOccurrence[] {
  const docs = new Map(documents.map((d) => [d.id, d]))

  const pulled: WordOccurrence[] = []
  for (const group of groupOccurrences(remoteRows.filter((row) => !purged.has(row.document_id)))) {
    if (recomputed.has(group.documentId)) continue
    const doc = docs.get(group.documentId)
    // 문서를 모르면 예문을 붙일 곳이 없다 — 본문이 없는 기록은 쓸 필요가 없다
    if (doc) pulled.push(occurrenceFromRows(group.rows, doc))
  }

  const pulledIds = new Set(pulled.map((o) => `${o.documentId}::${o.lemma}`))
  return [
    ...pulled,
    // 재계산한 문서는 pulled 에 없으므로 로컬 것이 그대로 남는다
    ...local.filter((o) => !purged.has(o.documentId) && !pulledIds.has(`${o.documentId}::${o.lemma}`)),
  ]
}