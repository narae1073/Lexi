import { create } from 'zustand'

import type { LanguageCode, WordStatus } from '../../types'
import type { WordbookEntry } from '../wordbook/buildWordbook'
import type { QuizWord } from './quizSession'

export type QuizPhase = 'setup' | 'session' | 'summary'

type QuizSessionState = {
  phase: QuizPhase
  languageCode: LanguageCode | null
  size: number | null
  words: QuizWord[]
  index: number
  sessionEntries: WordbookEntry[]
  answer: WordStatus | null
  results: WordStatus[]
  peeked: boolean
  selectLanguage: (languageCode: LanguageCode) => void
  selectSize: (size: number) => void
  startSession: (input: {
    languageCode: LanguageCode
    size: number
    entries: WordbookEntry[]
    words: QuizWord[]
  }) => void
  recordAnswer: (result: WordStatus) => void
  advance: () => void
  backToSetup: () => void
  markPeeked: () => void
  reset: () => void
}

const initialState = {
  phase: 'setup' as const,
  languageCode: null,
  size: null,
  words: [],
  index: 0,
  sessionEntries: [],
  answer: null,
  results: [],
  peeked: false,
}

/**
 * In-memory quiz session.
 *
 * This deliberately lives outside the QuizView component: the top-level tabs
 * are routes, so navigating away unmounts the view. Keeping the session here
 * makes returning to Quiz resume the same question/progress/settings, while a
 * page reload still starts fresh (and no large session snapshot is written to
 * localStorage).
 */
export const useQuizSessionStore = create<QuizSessionState>((set, get) => ({
  ...initialState,

  selectLanguage: (languageCode) => set({ languageCode, size: null }),
  selectSize: (size) => set({ size }),

  startSession: ({ languageCode, size, entries, words }) =>
    set({
      phase: 'session',
      languageCode,
      size,
      words,
      index: 0,
      sessionEntries: entries,
      answer: null,
      results: [],
      peeked: false,
    }),

  recordAnswer: (result) => {
    const state = get()
    if (state.phase !== 'session' || state.answer !== null || !state.words[state.index]) {
      return
    }
    const results = [...state.results]
    results[state.index] = result
    set({ answer: result, results })
  },

  advance: () => {
    const state = get()
    if (state.phase !== 'session') return
    if (state.index + 1 >= state.words.length) {
      set({ phase: 'summary' })
      return
    }
    set({ index: state.index + 1, answer: null, peeked: false })
  },

  backToSetup: () =>
    set({
      phase: 'setup',
      words: [],
      index: 0,
      sessionEntries: [],
      answer: null,
      results: [],
      peeked: false,
    }),

  markPeeked: () => set({ peeked: true }),
  reset: () => set(initialState),
}))
