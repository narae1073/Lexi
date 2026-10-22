import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import { STORES, idbGet } from '../../lib/storage/localDb'
import { wordStateToRow } from '../../lib/sync/mapping'
import type { WordState } from '../../types'
import { useWordStatesStore } from './wordStates'

const USER = 'user-1'

/** 저장은 화면을 막지 않으려고 뒤로 미룬다 (낙관적 UI) — 끝날 때를 기다린다 */
const waitForSave = () => new Promise((resolve) => setTimeout(resolve, 30))

/**
 * 별·메모는 상태와 독립이다.
 *
 * 별을 붙이거나 메모를 적었다고 그 단어를 '헷갈림' 으로 표시하면, 겉으로는
 * 표시하지 않은 단어가 단어장·퀴즈·진도에 섞여 든다. 상태를 고르지 않은
 * 단어는 상태가 비어 있어야 하고, 서버 행에는 null 로 나가야 한다.
 */
describe('즐겨찾기·메모만 한 단어는 표시하지 않는다', () => {
  beforeEach(() => {
    useWordStatesStore.setState({ byKey: {}, loaded: {} })
  })

  it('즐겨찾기만 하면 상태는 비어 있다 — 저장 행에도 null 로 나간다', async () => {
    useWordStatesStore.getState().toggleFavorite('en', 'apple', 'apple')

    expect(useWordStatesStore.getState().byKey['en::apple']?.status).toBeUndefined()
    expect(useWordStatesStore.getState().getStatus('en', 'apple')).toBeUndefined()

    await waitForSave()
    const stored = await idbGet<WordState>(STORES.wordStates, ['en', 'apple'])
    expect(stored?.favorite).toBe(true)
    expect(stored?.status).toBeUndefined()
    expect(wordStateToRow(USER, { ...stored!, favoriteUpdatedAt: stored!.lastSeenAt }).status).toBeNull()
  })

  it('메모만 적으면 상태는 비어 있다 — 저장 행에도 null 로 나간다', async () => {
    useWordStatesStore.getState().setNote('en', 'pear', 'pear = 배', 'pear')

    expect(useWordStatesStore.getState().byKey['en::pear']?.status).toBeUndefined()
    expect(useWordStatesStore.getState().getStatus('en', 'pear')).toBeUndefined()

    await waitForSave()
    const stored = await idbGet<WordState>(STORES.wordStates, ['en', 'pear'])
    expect(stored?.note).toBe('pear = 배')
    expect(stored?.status).toBeUndefined()
    expect(wordStateToRow(USER, { ...stored!, favoriteUpdatedAt: stored!.lastSeenAt }).status).toBeNull()
  })

  it('이미 표시한 단어의 상태는 즐겨찾기로 바뀌지 않는다', async () => {
    useWordStatesStore.getState().setStatus('en', 'apple', 'known', 'apple')
    useWordStatesStore.getState().toggleFavorite('en', 'apple', 'apple')

    expect(useWordStatesStore.getState().byKey['en::apple']?.status).toBe('known')

    await waitForSave()
    const stored = await idbGet<WordState>(STORES.wordStates, ['en', 'apple'])
    expect(stored?.status).toBe('known')
    expect(wordStateToRow(USER, { ...stored!, favoriteUpdatedAt: stored!.lastSeenAt }).status).toBe('known')
  })

  it('이미 표시한 단어의 상태는 메모로 바뀌지 않는다', async () => {
    useWordStatesStore.getState().setStatus('en', 'pear', 'known', 'pear')
    useWordStatesStore.getState().setNote('en', 'pear', 'pear = 배', 'pear')

    expect(useWordStatesStore.getState().byKey['en::pear']?.status).toBe('known')

    await waitForSave()
    const stored = await idbGet<WordState>(STORES.wordStates, ['en', 'pear'])
    expect(stored?.status).toBe('known')
    expect(wordStateToRow(USER, { ...stored!, favoriteUpdatedAt: stored!.lastSeenAt }).status).toBe('known')
  })

  it('200자를 넘는 lemma 는 즐겨찾기·메모에서도 막는다', () => {
    const longLemma = 'a'.repeat(201)
    useWordStatesStore.getState().toggleFavorite('en', longLemma, longLemma)
    useWordStatesStore.getState().setNote('en', longLemma, 'note', longLemma)

    expect(useWordStatesStore.getState().byKey[`en::${longLemma}`]).toBeUndefined()
  })
})
