import { create } from 'zustand'

import { STORES, idbGetAllByIndex, idbPut } from '../../lib/storage/localDb'
import type { LanguageCode, WordState, WordStatus } from '../../types'

/** IndexedDB 복합 키와 맞추기 위한 스토어 키 */
export function wordKey(languageCode: LanguageCode, lemma: string): string {
  return `${languageCode}::${lemma}`
}

type WordStatesStore = {
  /** key = `${languageCode}::${lemma}` */
  byKey: Record<string, WordState>
  setStatus: (
    languageCode: LanguageCode,
    lemma: string,
    status: WordStatus,
    surface?: string,
  ) => void
  loadLanguage: (languageCode: LanguageCode) => Promise<void>
  getStatus: (languageCode: LanguageCode, lemma: string) => WordStatus | undefined
}

/**
 * 단어 상태는 전역 저장 (PLAN.md §4) — 문서가 달라도 같은 단어는 같은 상태다.
 * 화면 반영을 먼저 하고 저장은 뒤로 미룬다(낙관적 UI).
 */
export const useWordStatesStore = create<WordStatesStore>((set, get) => ({
  byKey: {},

  getStatus: (languageCode, lemma) => get().byKey[wordKey(languageCode, lemma)]?.status,

  setStatus: (languageCode, lemma, status, surface) => {
    const key = wordKey(languageCode, lemma)
    const previous = get().byKey[key]
    const timestamp = new Date().toISOString()

    const next: WordState = {
      lemma,
      languageCode,
      status,
      seenCount: previous?.seenCount ?? 1,
      firstSeenAt: previous?.firstSeenAt ?? timestamp,
      lastSeenAt: timestamp,
    }

    set((s) => ({ byKey: { ...s.byKey, [key]: next } }))

    if (previous?.status === status) return
    void idbPut(STORES.wordStates, { ...next, surface }).catch((error) => {
      console.error('단어 상태 저장 실패', error)
    })
  },

  loadLanguage: async (languageCode) => {
    const rows = await idbGetAllByIndex<WordState & { surface?: string }>(
      STORES.wordStates,
      'languageCode',
      languageCode,
    )
    set((s) => {
      const byKey = { ...s.byKey }
      for (const row of rows) {
        const { surface: _surface, ...state } = row
        byKey[wordKey(languageCode, state.lemma)] = state
      }
      return { byKey }
    })
  },
}))