import { create } from 'zustand'

import { STORES, idbGet, idbGetAllByIndex, idbPut } from '../../lib/storage/localDb'
import type { LanguageCode, WordState, WordStatus } from '../../types'
import { randomStarAngle, randomStarColor } from '../../features/reader/favoriteStar'
import { notifyLocalProjectionChange } from '../../features/wordbook/localProjection'
import { STAR_COLOR_DEFAULT } from './settings'

/** IndexedDB 복합 키와 맞추기 위한 스토어 키 */
export function wordKey(languageCode: LanguageCode, lemma: string): string {
  return `${languageCode}::${lemma}`
}

/**
 * Local-only wordbook: a state edit patches exactly one projection row.
 *
 * The event carries the new state, so the producer never has to re-read a
 * 200k-row projection to find the row it already knows about. Account mode has
 * no local producer subscribed, so this is a no-op there.
 */
function announceState(state: WordState & { favoriteUpdatedAt?: string }): void {
  notifyLocalProjectionChange({
    type: 'state',
    languageCode: state.languageCode,
    lemma: state.lemma,
    state,
  })
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
   * 표시를 없앤다 — 같은 버튼을 한 번 더 누른 것이다.
   *
   * 행은 남긴다. 별·읽은 기록이 같은 행에 있으므로 행까지 지우면 별이 함께
   * 사라진다. 상태만 빼고 시각을 새로 찍으면, 동기화에서 '늦게 없앤 쪽' 이
   * 이겨 서버 행도 지워진다. 다시 표시하면 그때부터 새 기록이다.
   */
  clearStatus: (languageCode: LanguageCode, lemma: string) => void
  /**
   * 즐겨찾기 ☆/★.
   *
   * 상태와 독립이다 — 별을 붙인다고 상태가 바뀌지 않고, 상태를 바꾼다고 별이
   * 떨어지지 않는다. 붙일 때마다 기울기와 색을 새로 뽑는다 — 같은 단어도 매번
   * 다른 별이 된다. 별의 시각을 따로 찍어 두 기기가 달라도 '늦게 누른 쪽' 이
   * 이긴다.
   */
  toggleFavorite: (languageCode: LanguageCode, lemma: string, surface?: string) => void
  /**
   * 별 스티커의 색을 고른다 — 색창의 9색 중 하나.
   *
   * 별이 있는 단어에만 된다. 색을 바꾸는 것도 별의 변경이라 시각을 찍어
   * 동기화에 실어 보낸다.
   */
  setStarColor: (languageCode: LanguageCode, lemma: string, color: string, surface?: string) => void
  /**
   * 단어 메모를 적는다 — 어원·연상·내 예문.
   *
   * 상태·별과 독립이고, 마지막으로 본 시각도 건드리지 않는다 (메모를 적은 것은
   * 복습이 아니다). 메모의 시각을 따로 찍어 두 기기가 달라도 늦게 고친 쪽이 이긴다.
   */
  setNote: (languageCode: LanguageCode, lemma: string, note: string, surface?: string) => void
  /**
   * 이 언어의 상태를 읽는다.
   *
   * `force` 는 **동기화가 방금 써 넣은 것을 화면에 반영할 때** 쓴다.
   */
  loadLanguage: (languageCode: LanguageCode, options?: { force?: boolean }) => Promise<void>
  /**
   * 퀴즈에서 상태 단추를 누른 것을 기록한다.
   *
   * 누른 단추와 실제로 저장되는 상태가 다를 수 있다 — '모름' 인 단어에서 '앎' 을
   * 누르면 상태는 '헷갈림' 이 된다 (퀴즈의 전이 규칙). 그래서 둘을 나눠 받는다:
   * `result` 는 저장할 상태, `pressed` 는 센 단추다. 횟수는 눌린 단추를 센다.
   *
   * 상태와 횟수가 함께 바뀌므로 한 번만 저장한다 (setStatus 처럼 상태가 그대로면
   * 건너뛰지 않는다 — 횟수는 늘었기 때문이다).
   */
  pressStatus: (
    languageCode: LanguageCode,
    lemma: string,
    result: WordStatus,
    pressed: WordStatus,
    surface?: string,
  ) => void
  getStatus: (languageCode: LanguageCode, lemma: string) => WordStatus | undefined
}

/**
 * 서버의 word_states.lemma_len 과 같은 상한.
 *
 * 넘는 lemma 는 서버가 거부하므로 화면에서 먼저 막는다 — 한 행이 거부되면
 * 그 뒤의 정상 변경까지 동기화 큐에 걸린다.
 */
const MAX_LEMMA_LENGTH = 200

/** 누른 단추(status) → WordState 의 횟수 필드 */
const PRESS_FIELD: Record<WordStatus, 'knownPresses' | 'unsurePresses' | 'unknownPresses'> = {
  known: 'knownPresses',
  unsure: 'unsurePresses',
  unknown: 'unknownPresses',
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
    if (lemma.length > MAX_LEMMA_LENGTH) return
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
      // 상태만 바꿨다고 별이 떨어지면 안 된다 — 별은 별의 길로 간다
      favorite: previous?.favorite ?? false,
      starAngle: previous?.starAngle ?? 0,
      starColor: previous?.starColor ?? STAR_COLOR_DEFAULT,
      // 누른 횟수는 상태와 무관하게 쌓인다 — 여기서는 이어받기만 한다 (세는 것은 퀴즈뿐)
      knownPresses: previous?.knownPresses ?? 0,
      unsurePresses: previous?.unsurePresses ?? 0,
      unknownPresses: previous?.unknownPresses ?? 0,
      note: previous?.note,
      noteUpdatedAt: previous?.noteUpdatedAt,
    }

    set((s) => ({ byKey: { ...s.byKey, [key]: next } }))
    announceState(next)

    if (previous?.status === status) return
    void idbPut(STORES.wordStates, { ...next, surface }).catch((error) => {
      console.error('단어 상태 저장 실패', error)
    })
  },

  pressStatus: (languageCode, lemma, result, pressed, surface) => {
    if (lemma.length > MAX_LEMMA_LENGTH) return
    const key = wordKey(languageCode, lemma)
    const previous = get().byKey[key]
    const timestamp = new Date().toISOString()
    const field = PRESS_FIELD[pressed]

    const next: WordState = {
      lemma,
      languageCode,
      status: result,
      seenCount: previous?.seenCount ?? 1,
      firstSeenAt: previous?.firstSeenAt ?? timestamp,
      lastSeenAt: timestamp,
      favorite: previous?.favorite ?? false,
      starAngle: previous?.starAngle ?? 0,
      starColor: previous?.starColor ?? STAR_COLOR_DEFAULT,
      knownPresses: previous?.knownPresses ?? 0,
      unsurePresses: previous?.unsurePresses ?? 0,
      unknownPresses: previous?.unknownPresses ?? 0,
      note: previous?.note,
      noteUpdatedAt: previous?.noteUpdatedAt,
    }
    next[field] = (previous?.[field] ?? 0) + 1

    set((s) => ({ byKey: { ...s.byKey, [key]: next } }))
    announceState(next)

    // 상태가 그대로여도 저장한다 — 횟수가 늘었기 때문이다
    void idbPut(STORES.wordStates, { ...next, surface }).catch((error) => {
      console.error('퀴즈 단추 횟수 저장 실패', error)
    })
  },

  clearStatus: (languageCode, lemma) => {
    if (lemma.length > MAX_LEMMA_LENGTH) return
    const key = wordKey(languageCode, lemma)
    const previous = get().byKey[key]
    // 표시한 적이 없으면 없앨 것도 없다
    if (previous?.status === undefined) return
    const timestamp = new Date().toISOString()

    const { status: _removed, ...kept } = previous
    const next = { ...kept, lastSeenAt: timestamp }
    set((s) => ({ byKey: { ...s.byKey, [key]: next } }))
    announceState(next)

    // 저장된 행에서 상태만 뺀다 — 별·읽은 기록·별 시각은 그대로 둔다.
    // lastSeenAt 을 새로 찍어야 동기화에서 이 '없앰' 이 이긴다.
    void (async () => {
      try {
        const stored = await idbGet<WordState>(STORES.wordStates, [languageCode, lemma])
        if (!stored) {
          await idbPut(STORES.wordStates, next)
          return
        }
        const { status: _dropped, ...rest } = stored
        await idbPut(STORES.wordStates, { ...rest, lastSeenAt: timestamp })
      } catch (error) {
        console.error('단어 표시 없애기 실패', error)
      }
    })()
  },

  toggleFavorite: (languageCode, lemma, surface) => {
    if (lemma.length > MAX_LEMMA_LENGTH) return
    const key = wordKey(languageCode, lemma)
    const previous = get().byKey[key]
    const timestamp = new Date().toISOString()
    const favoriting = !(previous?.favorite ?? false)

    const next: WordState = {
      lemma,
      languageCode,
      // 상태와 독립이다 — 별만 붙인 단어는 표시하지 않은 채로 둔다
      status: previous?.status,
      seenCount: previous?.seenCount ?? 1,
      firstSeenAt: previous?.firstSeenAt ?? timestamp,
      lastSeenAt: previous?.lastSeenAt ?? timestamp,
      favorite: favoriting,
      // 붙일 때마다 새로 뽑는다 — 뗐다 다시 붙이면 다른 별이 된다.
      // 뗄 때는 값을 지우지 않는다. 다시 붙일 때 이전 색을 빼고 뽑으려면
      // 기억하고 있어야 한다.
      starAngle: favoriting ? randomStarAngle() : (previous?.starAngle ?? 0),
      starColor: favoriting
        ? randomStarColor(previous?.starColor)
        : (previous?.starColor ?? STAR_COLOR_DEFAULT),
      knownPresses: previous?.knownPresses ?? 0,
      unsurePresses: previous?.unsurePresses ?? 0,
      unknownPresses: previous?.unknownPresses ?? 0,
      note: previous?.note,
      noteUpdatedAt: previous?.noteUpdatedAt,
    }

    set((s) => ({ byKey: { ...s.byKey, [key]: next } }))

    // 별을 누른 것은 진도다 — 다음 동기화에 실어 보낸다
    announceState({ ...next, favoriteUpdatedAt: timestamp })
    void idbPut(STORES.wordStates, {
      ...next,
      surface,
      favoriteUpdatedAt: timestamp,
    }).catch((error) => {
      console.error('즐겨찾기 저장 실패', error)
    })
  },

  setStarColor: (languageCode, lemma, color, surface) => {
    if (lemma.length > MAX_LEMMA_LENGTH) return
    const key = wordKey(languageCode, lemma)
    const previous = get().byKey[key]
    // 별이 없으면 바꿀 색도 없다 — 팝오버에서 별이 있을 때만 보여준다
    if (!previous?.favorite) return
    const timestamp = new Date().toISOString()

    const next: WordState = { ...previous, starColor: color }

    set((s) => ({ byKey: { ...s.byKey, [key]: next } }))
    announceState({ ...next, favoriteUpdatedAt: timestamp })

    void idbPut(STORES.wordStates, {
      ...next,
      surface,
      favoriteUpdatedAt: timestamp,
    }).catch((error) => {
      console.error('별 색 저장 실패', error)
    })
  },

  setNote: (languageCode, lemma, note, surface) => {
    if (lemma.length > MAX_LEMMA_LENGTH) return
    const key = wordKey(languageCode, lemma)
    const previous = get().byKey[key]
    const timestamp = new Date().toISOString()
    const trimmed = note.trim()

    const next: WordState = {
      lemma,
      languageCode,
      // 메모만 적은 단어도 행이 생기지만, 상태는 표시하지 않은 채로 둔다
      // (서버의 status 는 nullable 이고 wordStateToRow 가 null 로 보낸다)
      status: previous?.status,
      seenCount: previous?.seenCount ?? 1,
      firstSeenAt: previous?.firstSeenAt ?? timestamp,
      // 메모를 적은 것은 복습이 아니다 — 있던 시각은 그대로 둔다
      lastSeenAt: previous?.lastSeenAt ?? timestamp,
      favorite: previous?.favorite ?? false,
      starAngle: previous?.starAngle ?? 0,
      starColor: previous?.starColor ?? STAR_COLOR_DEFAULT,
      knownPresses: previous?.knownPresses ?? 0,
      unsurePresses: previous?.unsurePresses ?? 0,
      unknownPresses: previous?.unknownPresses ?? 0,
      note: trimmed || undefined,
      noteUpdatedAt: timestamp,
    }

    set((s) => ({ byKey: { ...s.byKey, [key]: next } }))
    announceState(next)

    void idbPut(STORES.wordStates, {
      ...next,
      surface,
    }).catch((error) => {
      console.error('단어 메모 저장 실패', error)
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