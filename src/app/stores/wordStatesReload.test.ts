import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import { STORES, idbPut } from '../../lib/storage/localDb'
import type { WordStatus } from '../../types'
import { useWordStatesStore } from './wordStates'

/**
 * 다른 기기에서 받은 진도가 화면에 나타나야 한다.
 *
 * 회귀: `loadLanguage` 은 **한 번만** 읽었다. 앱 시작 시 읽은 직후 동기화가 병합 결과를
 * IndexedDB 에 써 넣는데, 다시 읽지 않았다. 그래서 다른 기기에서 온 진도가 서버와
 * IndexedDB 에는 있고 **화면에는 없었다** — 새로고침을 한 번 더 해야 보였던 이유가 이것이다.
 *
 * 사용자의 질문은 '서버에 없던가' 였다. 실제로는 서버에 있었고, 그 기기에
 * 도착해 있었다. 화면이 읽지 않았을 뿐이었다.
 */
describe('받아 온 진도가 화면에 나타난다', () => {
  const row = (lemma: string, status: WordStatus = 'known') => ({
    languageCode: 'fr',
    lemma,
    status,
    seenCount: 1,
    firstSeenAt: '2026-10-01T00:00:00.000Z',
    lastSeenAt: '2026-10-05T00:00:00.000Z',
  })

  beforeEach(() => {
    useWordStatesStore.setState({ byKey: {}, loaded: {} })
  })

  it('처음 읽으면 나타난다', async () => {
    await idbPut(STORES.wordStates, row('été'))
    await useWordStatesStore.getState().loadLanguage('fr')
    expect(useWordStatesStore.getState().byKey['fr::été']?.status).toBe('known')
  })

  it('이미 읽은 언어는 다시 읽지 않는다 — 매번 읽으면 느려진다', async () => {
    await idbPut(STORES.wordStates, row('été'))
    await useWordStatesStore.getState().loadLanguage('fr')
    useWordStatesStore.setState({ byKey: {} })

    await useWordStatesStore.getState().loadLanguage('fr')
    expect(useWordStatesStore.getState().byKey['fr::été']).toBeUndefined()
  })

  /**
   * 이게 핵심이다.
   *
   * 앱이 이미 읽은 뒤에 동기화가 다른 기기의 진도를 써 넣는다. force 없이 부르면 아무것도
   * 하지 않아 그 진도는 세션 끝까지 화면에 없다 — 사용자에게는 '서버에 없던가' 로 보인다.
   */
  it('force 를 주면 나중에 들어온 것도 나타난다', async () => {
    // 앱 시작 시점: 아직 서버를 받지 않았다
    await useWordStatesStore.getState().loadLanguage('fr')
    expect(useWordStatesStore.getState().byKey['fr::chat']).toBeUndefined()

    // 동기화가 다른 기기의 진도를 써 넣었다
    await idbPut(STORES.wordStates, row('chat'))
    await idbPut(STORES.wordStates, row('été'))

    // force 로 다시 읽는다 — 이것을 하지 않으면 화면에 없다
    await useWordStatesStore.getState().loadLanguage('fr', { force: true })

    const { byKey } = useWordStatesStore.getState()
    expect(byKey['fr::chat']?.status).toBe('known')
    expect(byKey['fr::été']?.status).toBe('known')
  })

  it('force 여도 다른 언어는 건드리지 않는다', async () => {
    await useWordStatesStore.getState().loadLanguage('en')
    await idbPut(STORES.wordStates, row('chat'))
    await useWordStatesStore.getState().loadLanguage('fr', { force: true })
    expect(useWordStatesStore.getState().byKey['en::chat']).toBeUndefined()
  })

  /**
   * 다시 읽을 때는 합친다 — 비우지 않는다.
   *
   * 방금 누른 표시가 아직 저장소에 가기 전에 다시 읽힐 수 있다. 비우면 눌렀던 표시가
   * 사라지는 것이 오히려 나쁘다. 단어 상태는 이 앱에서 지워지지 않으므로 합치기로 충분하다.
   */
  it('force 를 주어도 방금 누른 표시는 남는다', async () => {
    await useWordStatesStore.getState().loadLanguage('fr')
    // 사용자가 눌렀다 — 저장은 뒤로 미룬다(낙관적 UI)
    useWordStatesStore.setState((s) => ({
      byKey: { ...s.byKey, 'fr::chat': { languageCode: 'fr', lemma: 'chat', status: 'known', seenCount: 1, firstSeenAt: 'x', lastSeenAt: 'y' } },
    }))

    await useWordStatesStore.getState().loadLanguage('fr', { force: true })
    expect(useWordStatesStore.getState().byKey['fr::chat']?.status).toBe('known')
  })
})