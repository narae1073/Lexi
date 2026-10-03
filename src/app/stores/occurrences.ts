import { create } from 'zustand'

import { STORES, idbDeleteByIndex, idbGetAllByIndex, replaceOccurrences } from '../../lib/storage/localDb'
import { isSentenceInitial, tokenize } from '../../features/reader/tokenizer'
import { resolveLemmasFromWords } from '../../features/reader/surfaceLemma'
import type { Document, LanguageCode } from '../../types'

/**
 * 단어가 문서에서 실제로 등장한 기록.
 *
 * 왜 이것이 필요한가: 단어 상태(○◐●)는 사용자가 직접 바꾼 단어에만 생긴다.
 * 문서에는 있지만 아직 건드리지 않은 단어는 어디에도 남지 않아,
 * 단어장이 "클릭한 단어만 모은 목록" 이 되어 버린다. 등장 기록이 그 원본 데이터다.
 *
 * schema(word_occurrences) 와 같은 형태이며, Phase 6 에서 서버로 옮길 때 그대로 쓴다.
 */
export type WordOccurrence = {
  documentId: string
  languageCode: LanguageCode
  /** 표기 → lemma 매핑으로 정규화한 대표 형태 (US 와 us 는 분리된다) */
  lemma: string
  /** 이 lemma 이 이 문서에서 쓰인 표기들 */
  surfaces: string[]
  /** 등장 횟수 */
  count: number
  /** 단어장의 문맥 예문 */
  charStart: number
  charEnd: number
  sentence: string
  documentTitle: string
}

type OccurrencesState = {
  /** languageCode 별 등장 기록 */
  byLanguage: Record<string, WordOccurrence[]>
  /** 이미 기록을 끝낸 문서 id — 다시 열 때 중복 기록하지 않기 위함 */
  recorded: Record<string, true>
  recordDocument: (doc: Document, force?: boolean) => Promise<void>
  loadLanguage: (languageCode: LanguageCode) => Promise<void>
  forgetDocument: (documentId: string) => Promise<void>
}

/** 단어장 정렬용: 문서 내 등장 순서를 유지한다 */
function sortByPosition(a: WordOccurrence, b: WordOccurrence) {
  return a.charStart - b.charStart
}

export const useOccurrencesStore = create<OccurrencesState>((set, get) => ({
  byLanguage: {},
  recorded: {},

  loadLanguage: async (languageCode) => {
    const rows = await idbGetAllByIndex<WordOccurrence>(
      STORES.wordOccurrences,
      'languageCode',
      languageCode,
    )
    rows.sort(sortByPosition)
    set((s) => ({ byLanguage: { ...s.byLanguage, [languageCode]: rows } }))
  },

  recordDocument: async (doc, force = false) => {
    if (!force && get().recorded[doc.id]) return

    const { segments, sentences } = tokenize(doc.rawText, doc.languageCode)
    const words = segments.filter((s) => s.type === 'word')
    if (words.length === 0) return

    // 문서 안에서 실제로 쓰인 표기만 보고 lemma 를 정한다 (US/us 분리 등)
    const lemmaOf = resolveLemmasFromWords(
      words.map((w) => ({
        text: w.text,
        // 문장의 첫 단어여도 문서 중간에 다시 나오면 구분 단서가 된다
        sentenceInitial: isSentenceInitial(doc.rawText, sentences, w.start, w.sentenceIndex),
      })),
    )

    const byLemma = new Map<string, WordOccurrence>()
    for (const word of words) {
      const lemma = lemmaOf.get(word.text) ?? word.lemma
      const existing = byLemma.get(lemma)
      if (existing) {
        existing.count += 1
        if (!existing.surfaces.includes(word.text)) existing.surfaces.push(word.text)
        continue
      }
      byLemma.set(lemma, {
        documentId: doc.id,
        languageCode: doc.languageCode,
        lemma,
        surfaces: [word.text],
        count: 1,
        charStart: word.start,
        charEnd: word.end,
        sentence: (sentences[word.sentenceIndex]?.text ?? '').trim(),
        documentTitle: doc.title,
      })
    }

    const records = [...byLemma.values()].sort(sortByPosition)
    await replaceOccurrences(doc.id, records)

    set((s) => ({
      recorded: { ...s.recorded, [doc.id]: true },
      byLanguage: { ...s.byLanguage, [doc.languageCode]: records },
    }))
  },

  forgetDocument: async (documentId) => {
    await idbDeleteByIndex(STORES.wordOccurrences, 'documentId', documentId)
    set((s) => {
      const recorded = { ...s.recorded }
      delete recorded[documentId]
      const byLanguage: Record<string, WordOccurrence[]> = {}
      for (const [language, rows] of Object.entries(s.byLanguage)) {
        byLanguage[language] = rows.filter((r) => r.documentId !== documentId)
      }
      return { recorded, byLanguage }
    })
  },
}))