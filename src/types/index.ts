import type { SupportedLanguageCode } from '../lib/languages'

/** 배울 언어 코드. 화이트리스트에 있는 값만 문서 언어로 쓰인다. */
export type LanguageCode = SupportedLanguageCode

/** plan.txt 4줄: 단어 상태 3단계 */
export const WORD_STATUSES = ['known', 'unsure', 'unknown'] as const
export type WordStatus = (typeof WORD_STATUSES)[number]

/** 상태별 표시 기호 (plan.txt 3줄: ○ ◐ ●) */
export const STATUS_GLYPH: Record<WordStatus, string> = {
  known: '○',
  unsure: '◐',
  unknown: '●',
}

export const STATUS_LABEL: Record<WordStatus, string> = {
  known: '아는 단어',
  unsure: '잘 모르는 단어',
  unknown: '모르는 단어',
}

/** 원문을 단어/일반 텍스트로 분절한 조각. 오프셋은 항상 원문 기준 문자 인덱스. */
export type Segment =
  | {
      type: 'word'
      start: number
      end: number
      text: string
      lemma: string
      sentenceIndex: number
    }
  | { type: 'text'; start: number; end: number; text: string }

/** 문장 경계. plan.txt 6줄 문장 선택의 기본 단위. */
export type Sentence = {
  index: number
  start: number
  end: number
  text: string
}

export type Document = {
  id: string
  title: string
  languageCode: LanguageCode
  rawText: string
  createdAt: string
  updatedAt: string
}

/** 언어별 단어 상태. 같은 단어는 문서와 무관하게 전역 공유 (PLAN.md §4). */
export type WordState = {
  lemma: string
  languageCode: LanguageCode
  status: WordStatus
  seenCount: number
  firstSeenAt: string
  lastSeenAt: string
}