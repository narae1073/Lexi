import { describe, expect, it } from 'vitest'

import { mergeByLanguage, type WordOccurrence } from '../../app/stores/occurrences'

const record = (documentId: string, lemma: string, charStart = 0): WordOccurrence => ({
  documentId,
  languageCode: 'de',
  lemma,
  surfaces: [lemma],
  count: 1,
  charStart,
  charEnd: charStart + lemma.length,
  sentence: lemma,
  documentTitle: `${documentId} 문서`,
  recordedAt: 1,
})

describe('언어별 기록 합치기', () => {
  /**
   * German 문서를 하나 열었다 닫았다 하며 German 단어장을 보면 그 문서 단어만 보인다.
   *
   * 언어를 열 때마다 배열을 갈아끼우면 같은 언어의 다른 문서들이 통째로 사라진다.
   * 사용자는 '단어장이 그 문서만 기억하나' 로 오해한다. 목록에도 안 나고 단어장에도
   * 안 나오니 어디 갔는지 알 방법이 없다.
   */
  it('다른 문서의 기록을 지우지 않는다', () => {
    const byLanguage = mergeByLanguage({}, 'de', 'doc-1', [record('doc-1', 'Haus')])
    const next = mergeByLanguage(byLanguage, 'de', 'doc-2', [record('doc-2', 'Wasser')])
    expect(next.de.map((r) => r.lemma)).toEqual(['Haus', 'Wasser'])
  })

  it('같은 문서를 다시 계산하면 그 문서 것만 갈아끼운다', () => {
    const first = mergeByLanguage({}, 'de', 'doc-1', [record('doc-1', 'Haus', 0)])
    // 표기 규칙이 바뀌어 lemma 가 달라졌다 — 이전 결과를 남겨 두면 둘이 함께 남는다
    const next = mergeByLanguage(first, 'de', 'doc-1', [record('doc-1', 'Haus', 0), record('doc-1', 'Hauses', 9)])
    expect(next.de.map((r) => r.lemma)).toEqual(['Haus', 'Hauses'])
  })

  /**
   * 위치 순으로 정렬한다 — 본문에서 등장한 순서대로 단어를 본다.
   *
   * 같은 문서를 다시 계산하면 이전 기록이 통째로 갈라진다 — 'zwei' 는 사라진다.
   * 이전 결과를 남겨 두면 같은 (문서, lemma) 가 두 번 세어진다.
   */
  it('위치 순으로 정렬하고 같은 문서의 옛 기록은 버린다', () => {
    const first = mergeByLanguage({}, 'de', 'doc-1', [record('doc-1', 'zwei', 20)])
    const next = mergeByLanguage(first, 'de', 'doc-1', [
      record('doc-1', 'eins', 0),
      record('doc-1', 'drei', 10),
      record('doc-1', 'vier', 30),
    ])
    expect(next.de.map((r) => r.lemma)).toEqual(['eins', 'drei', 'vier'])
  })

  it('다른 언어의 기록은 건드리지 않는다', () => {
    const byLanguage = { en: [record('doc-en', 'house')] }
    const next = mergeByLanguage(byLanguage, 'de', 'doc-1', [record('doc-1', 'Haus')])
    expect(next.en.map((r) => r.lemma)).toEqual(['house'])
    expect(next.de.map((r) => r.lemma)).toEqual(['Haus'])
  })

  it('기존에 없던 언어면 그대로 넣는다', () => {
    const next = mergeByLanguage({}, 'ko', 'doc-1', [record('doc-1', '물')])
    expect(next.ko).toHaveLength(1)
  })
})