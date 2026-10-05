import { describe, expect, it } from 'vitest'

import { documentProgress } from './documentProgress'
import { resolveLemmasFromWords } from './surfaceLemma'
import { isCapitalisedPosition, tokenize } from './tokenizer'
import type { WordOccurrence } from '../../app/stores/occurrences'

/** 본문 상태 바와 똑같은 계산 — ReaderView 의 stats 를 그대로 옮겼다 */
function readerStats(text: string, languageCode: 'fr' | 'en', byKey: Record<string, unknown>) {
  const { segments, sentences } = tokenize(text, languageCode)
  const words = segments
    .filter((s) => s.type === 'word')
    .map((s) => ({
      text: s.text,
      sentenceInitial: isCapitalisedPosition(text, sentences, s.start, s.sentenceIndex),
    }))
  const lemmaOf = resolveLemmasFromWords(words, languageCode)

  const byLemma = new Map<string, string | undefined>()
  for (const w of words) {
    const lemma = lemmaOf.get(w.text) ?? w.text
    if (!byLemma.has(lemma)) byLemma.set(lemma, (byKey[`${languageCode}::${lemma}`] as { status?: string } | undefined)?.status)
  }

  const uniqueWords = byLemma.size
  const marked = [...byLemma.values()].filter(Boolean).length
  return { uniqueWords, marked, percent: uniqueWords === 0 ? 0 : Math.round((marked / uniqueWords) * 100) }
}

/** 등장 기록을 문서 계산과 같은 방식으로 만든다 — recordDocument 와 같다 */
function rowsFor(text: string, languageCode: 'fr' | 'en', documentId: string, title: string): WordOccurrence[] {
  const { segments, sentences } = tokenize(text, languageCode)
  const words = segments
    .filter((s) => s.type === 'word')
    .map((s) => ({
      text: s.text,
      sentenceInitial: isCapitalisedPosition(text, sentences, s.start, s.sentenceIndex),
    }))
  const lemmaOf = resolveLemmasFromWords(words, languageCode)
  const byLemma = new Map<string, WordOccurrence>()
  for (const w of words) {
    const lemma = lemmaOf.get(w.text) ?? w.text
    if (byLemma.has(lemma)) continue
    byLemma.set(lemma, {
      documentId,
      languageCode,
      lemma,
      surfaces: [w.text],
      count: 1,
      charStart: 0,
      charEnd: w.text.length,
      sentence: '',
      documentTitle: title,
      recordedAt: 1,
    })
  }
  return [...byLemma.values()]
}

const listGauge = (rows: WordOccurrence[], byKey: Record<string, unknown>) => {
  const languageCode = rows[0]?.languageCode ?? 'fr'
  return documentProgress(rows, (lemma) => byKey[`${languageCode}::${lemma}`] as never)
}

/**
 * 본문의 상태 바와 목록의 게이지가 같은 말을 하는가.
 *
 * 둘은 다른 것을 본다 — 본문은 지금 규칙으로 다시 푸는 표기를, 목록은 **저장된 등장
 * 기록의 lemma** 을 본다. 저장된 것이 옛 규칙이면 조용히 다른 수가 나온다. 사용자는
 * 같은 문서에 대해 두 개의 진도를 보고 어느 쪽도 틀렸다고 알 수 없다.
 *
 *   본문: 100% (옅은 단어 없음)
 *   목록: 93%  ← 왜 다른가?
 */
describe('본문 상태 바와 목록 게이지가 같다', () => {
  const CASES: [string, string][] = [
    ['fr', "Le petit renard et la lune. J'aime d'été et l'eau."],
    ['fr', "Pour comprendre, il faut lire. Voici : Pour une fois."],
    ['fr', "Un renard dort. Un chat dort aussi."],
    ['en', 'The fox sleeps. It is a small fox.'],
  ]

  for (const [languageCode, text] of CASES) {
    it(`${languageCode} · ${text.slice(0, 28)}`, () => {
      const rows = rowsFor(text, languageCode as 'fr' | 'en', 'doc-1', 'Le petit renard et la lune')

      // 이 문서의 모든 단어를 표시한 상태로 만든다 — 본문이 '옅은 단어 없음' 이라고 하는 상황
      const byKey: Record<string, unknown> = {}
      for (const row of rows) byKey[`${languageCode}::${row.lemma}`] = { status: 'known' }

      const reader = readerStats(text, languageCode as 'fr' | 'en', byKey)
      const list = listGauge(rows, byKey)

      expect(list.total).toBe(reader.uniqueWords)
      expect(list.marked).toBe(reader.marked)
      expect(list.percent).toBe(reader.percent)
    })
  }

  /**
   * 실제 증상 — 일부만 표시한 상태에서도 둘이 어긋나지 않아야 한다.
   *
   * 한 단어만 빼면 93% 같은 수가 나온다. 본문은 100% 라면서 목록은 93% 라면,
   * 저장된 기록이 본문과 다른 말을 세고 있다는 뜻이다.
   */
  it('일부만 표시해도 어긋나지 않는다', () => {
    const text = "Le petit renard et la lune. J'aime d'été et l'eau."
    const rows = rowsFor(text, 'fr', 'doc-1', 'Le petit renard et la lune')
    const byKey: Record<string, unknown> = {}
    rows.forEach((row, i) => {
      byKey[`fr::${row.lemma}`] = { status: i === 0 ? undefined : 'known' }
    })

    const reader = readerStats(text, 'fr', byKey)
    const list = listGauge(rows, byKey)

    expect(list.total).toBe(reader.uniqueWords)
    expect(list.marked).toBe(reader.marked)
    expect(list.percent).toBe(reader.percent)
  })
})