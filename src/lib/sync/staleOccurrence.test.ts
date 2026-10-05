import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import { STORES, idbPut } from '../../lib/storage/localDb'
import { LEMMA_VERSION } from '../../features/reader/surfaceLemma'
import type { WordOccurrence } from '../../app/stores/occurrences'
import type { Document } from '../../types'
import { mergeOccurrences } from './mergeOccurrences'

const doc: Document = {
  id: 'doc-1',
  title: 'Le petit renard et la lune',
  languageCode: 'fr',
  rawText: "J'aime d'été.",
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
}

const occurrence = (lemma: string, over: Partial<WordOccurrence> = {}): WordOccurrence => ({
  documentId: doc.id,
  languageCode: 'fr',
  lemma,
  surfaces: [lemma],
  count: 1,
  charStart: 0,
  charEnd: lemma.length,
  sentence: '',
  documentTitle: doc.title,
  recordedAt: 1,
  ...over,
})

/**
 * 서버에 옛 표기 규칙의 기록이 남아 있을 때.
 *
 * 회귀: 동기화는 서버의 등장 기록을 매번 다시 넣어준다. 새 규칙에서 나오지 않는 키
 * (프랑스어 축약 전의 `l'été` 같은)는 같은 키로 덮어써지지 않으므로 살아남는다.
 * 목록은 그 옛 키를 '옳지 않은 단어' 로 함께 세고, 본문은 지금 규칙으로 풀어서
 * 100% 라고 한다 — 같은 문서에 두 개의 진도가 생긴다.
 *
 *     본문 상태 바: 100%  (옅은 단어 없음)
 *     목록 게이지:  93%
 */
describe('서버에 옛 기록이 남아 있어도 되살아나지 않는다', () => {
  beforeEach(async () => {
    await idbPut(STORES.documents, doc)
  })

  /** 이 기기에서 현재 규칙으로 계산한 문서 */
  const markRecomputed = async () => {
    await idbPut(STORES.documentMeta, { documentId: doc.id, lemmaVersion: LEMMA_VERSION })
  }

  /** 옛 규칙으로 계산된 서버 행 */
  const staleRemoteRow = () => ({
    id: 1,
    user_id: 'u-1',
    document_id: doc.id,
    language_code: 'fr',
    lemma: "l'été",
    surface: "d'été",
    char_start: 7,
    char_end: 13,
    sentence: "J'aime d'été.",
    occurrences_count: 1,
  })

  it('재계산한 문서는 서버 것을 받지 않는다', async () => {
    await markRecomputed()
    const local = [occurrence('été'), occurrence('aime')]

    const merged = mergeOccurrences(local, [staleRemoteRow()], new Set([doc.id]), [doc])

    expect(merged.map((o) => o.lemma).sort()).toEqual(['aime', 'été'])
    expect(merged.map((o) => o.lemma)).not.toContain("l'été")
  })

  it('계산하지 않은 문서는 서버 것을 받는다 — 다른 기기에서 한 일이 와야 한다', () => {
    const local = [occurrence('été')]
    const merged = mergeOccurrences(local, [staleRemoteRow()], new Set(), [doc])
    expect(merged.some((o) => o.lemma === "l'été")).toBe(true)
  })

  /**
   * 매 동기화마다 옛 키가 다시 들어오면 사용자는 고칠 수 없다 — 무엇을 표시해도
   * 진도가 낮은 채로 남는다.
   */
  it('여러 번 돌려도 옛 키가 늘지 않는다', async () => {
    await markRecomputed()
    const local = [occurrence('été'), occurrence('aime')]
    for (let i = 0; i < 5; i++) {
      const merged = mergeOccurrences(local, [staleRemoteRow()], new Set([doc.id]), [doc])
      expect(merged).toHaveLength(2)
      expect(merged.map((o) => o.lemma)).not.toContain("l'été")
    }
  })

  it('완전 삭제한 문서의 옛 행은 서버에 남아 있어도 받지 않는다', () => {
    const merged = mergeOccurrences([], [staleRemoteRow()], new Set(), [doc], new Set([doc.id]))
    expect(merged).toHaveLength(0)
  })
})
