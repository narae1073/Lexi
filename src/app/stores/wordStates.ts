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
  /** IndexedDB 에서 읽어 온 언어 — 같은 언어를 중복 읽지 않기 위함 */
  loaded: Record<string, true>
  setStatus: (
    languageCode: LanguageCode,
    lemma: string,
    status: WordStatus,
    surface?: string,
  ) => void
  /**
   * 이 언어의 상태를 읽는다.
   *
   * `force` 는 **동기화가 방금 써 넣은 것을 화면에 반영할 때** 쓴다.
   */
  loadLanguage: (languageCode: LanguageCode, options?: { force?: boolean }) => Promise<void>
  getStatus: (languageCode: LanguageCode, lemma: string) => WordStatus | undefined
}

/**
 * 단어 상태는 전역 저장 (PLAN.md §4) — 문서가 달라도 같은 단어는 같은 상태다.
 * 화면 반영을 먼저 하고 저장은 뒤로 미룬다(낙관적 UI).
 */
export const useWordStatesStore = create<WordStatesStore>((set, get) => ({
  byKey: {},
  loaded: {},

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

  /**
   * IndexedDB 에서 언어 하나의 상태를 읽어 온다.
   *
   * 여기서 읽지 않은 언어의 상태는 화면에 없다 — 새로고침 직후 단어장이
   * 전부 "미표시" 로 보이던 문제가 정확히 그것이다. 앱 시작 시 배운 언어 전체에
   * 대해 호출되므로 문서를 따로 열 필요가 없다.
   */
  /**
   * 앱 시작 시 배운 언어 전체에 대해 호출되므로 문서를 따로 열 필요가 없다.
   *
   * 그런데 **한 번만 읽는다.** 동기화는 이 시점 뒤에 병합 결과를 IndexedDB 에 써 넣는데,
   * 여기서는 다시 읽지 않는다. 그래서 다른 기기에서 받은 진도가 서버와 IndexedDB 에는
   * 있는데 화면에는 없다 — 새로고침을 한 번 더 해야 보였던 이유가 이것이다.
   *
   * 그래서 동기화 뒤에는 `force` 로 한 번 더 읽는다.
   */
  loadLanguage: async (languageCode, options) => {
    if (!options?.force && get().loaded[languageCode]) return

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
      return { byKey, loaded: { ...s.loaded, [languageCode]: true } }
    })
  },
}))