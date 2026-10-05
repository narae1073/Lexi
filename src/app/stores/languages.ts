import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { SUPPORTED_LANGUAGES } from '../../lib/languages'
import type { LanguageCode } from '../../types'

type LanguagesState = {
  enrolled: LanguageCode[]
  /**
   * 온보딩을 끝냈는지. false면 앱 시작 시 선택 화면으로 보낸다.
   *
   * 언어를 하나 고른 순간 참이 되면 안 된다 — 고르는 중에도 저장이 되므로,
   * 첫 화면에서 하나를 눌렀다가 계단식으로 튕겨 나가는 셈이 된다. 명시적으로
   * 끝내야 다음 화면으로 간다.
   */
  ready: boolean
  toggle: (code: LanguageCode) => void
  /** 선택을 끝냈다고 알린다 — 언어가 하나도 없으면 거절한다 */
  finish: () => boolean
  /**
   * 계정에서 받은 언어를 반영한다.
   *
   * 기기마다 배운 언어가 다르다 — 폰에서 법어를 추가하고 노트북에서 보면 거기에도
   * 있어야 한다. 그래서 로그인하면 계정의 언어를 그대로 채택한다.
   */
  adopt: (codes: LanguageCode[]) => void
  reset: () => void
}

export const useLanguagesStore = create<LanguagesState>()(
  persist(
    (set, get) => ({
      enrolled: [],
      ready: false,
      toggle: (code) =>
        set((state) => {
          const known = SUPPORTED_LANGUAGES.some((l) => l.code === code)
          if (!known) return state
          const enrolled = state.enrolled.includes(code)
            ? state.enrolled.filter((c) => c !== code)
            : [...state.enrolled, code]
          // ready 는 여기서 건드리지 않는다 — 고르는 것과 끝내는 것은 다르다
          return { enrolled }
        }),

      finish: () => {
        if (get().enrolled.length === 0) return false
        set({ ready: true })
        return true
      },

      adopt: (codes) =>
        set((state) => {
          const enrolled = codes.filter((code) =>
            SUPPORTED_LANGUAGES.some((l) => l.code === code),
          )
          if (enrolled.length === 0) return state
          if (state.enrolled.length === enrolled.length &&
              state.enrolled.every((c, i) => c === enrolled[i])) {
            return state
          }
          // 계정 언어를 받아온 순간 온보딩은 끝난 것으로 본다 — 새 기기에서 같은
          // 선택을 다시 하지 않게 하는 것이 그 이유다
          return { enrolled, ready: true }
        }),

      reset: () => set({ enrolled: [], ready: false }),
    }),
    { name: 'lexi.languages' },
  ),
)