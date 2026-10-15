import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import { STORES, idbGet } from '../../lib/storage/localDb'
import { useWordStatesStore } from './wordStates'

/**
 * 퀴즈에서 상태 단추를 누른 횟수를 센다 (나중에 쓰려고 저장만 해 둔다).
 *
 * 세는 것은 **누른 단추** 다 — 실제로 저장된 상태가 아니다. '모름' 인 단어에서
 * '앎' 을 누르면 상태는 '헷갈림' 이 되지만, 누른 것은 '앎' 이므로 '앎' 을 센다.
 * 상태를 세면 이 경우가 '앎' 에서 영영 안 잡힌다.
 */
describe('퀴즈 단추 누른 횟수', () => {
  beforeEach(() => {
    useWordStatesStore.setState({ byKey: {}, loaded: {} })
  })

  it('누른 단추를 센다 — 저장된 상태(헷갈림)가 아니라 누른 것(앎)을 센다', () => {
    useWordStatesStore.getState().pressStatus('en', 'apple', 'unsure', 'known', 'apple')
    const state = useWordStatesStore.getState().byKey['en::apple']
    expect(state?.status).toBe('unsure')
    expect(state?.knownPresses).toBe(1)
    expect(state?.unsurePresses).toBe(0)
    expect(state?.unknownPresses).toBe(0)
  })

  it('여러 번 누르면 항목별로 쌓인다', () => {
    const store = useWordStatesStore.getState()
    store.pressStatus('en', 'apple', 'unsure', 'known', 'apple')
    store.pressStatus('en', 'apple', 'known', 'known', 'apple')
    store.pressStatus('en', 'apple', 'unknown', 'unknown', 'apple')
    const state = useWordStatesStore.getState().byKey['en::apple']
    expect(state?.knownPresses).toBe(2)
    expect(state?.unsurePresses).toBe(0)
    expect(state?.unknownPresses).toBe(1)
  })

  it('저장된다 — 나중에 읽을 수 있다', async () => {
    useWordStatesStore.getState().pressStatus('en', 'apple', 'known', 'known', 'apple')
    // 저장은 화면을 막지 않으려고 뒤로 미룬다 (낙관적 UI) — 끝날 때를 기다린다
    await new Promise((resolve) => setTimeout(resolve, 30))
    const stored = await idbGet<{ knownPresses: number }>(STORES.wordStates, ['en', 'apple'])
    expect(stored?.knownPresses).toBe(1)
  })

  it('읽기 화면·단어장에서 상태만 바꾼 것은 세지 않는다 — 퀴즈에서만 센다', () => {
    useWordStatesStore.getState().setStatus('en', 'apple', 'known', 'apple')
    const state = useWordStatesStore.getState().byKey['en::apple']
    expect(state?.knownPresses).toBe(0)
    expect(state?.unsurePresses).toBe(0)
    expect(state?.unknownPresses).toBe(0)
  })

  it('별을 붙여도 누른 횟수는 그대로다 — 상태와 독립', () => {
    useWordStatesStore.getState().pressStatus('en', 'apple', 'known', 'known', 'apple')
    useWordStatesStore.getState().toggleFavorite('en', 'apple', 'apple')
    const state = useWordStatesStore.getState().byKey['en::apple']
    expect(state?.knownPresses).toBe(1)
    expect(state?.favorite).toBe(true)
  })
})
