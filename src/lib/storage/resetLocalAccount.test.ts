import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LOCAL_OWNER_KEY,
  readLocalOwner,
  writeLocalOwner,
  type OwnerStorage,
} from './accountOwner'
import { STORES, deleteLocalDatabase, idbGetAll, idbPut } from './localDb'
import { resetLocalAccount } from './resetLocalAccount'

/**
 * jsdom 이 없으므로 저장 계약만 만족하는 스텁을 세운다.
 * `lexi.settings` 는 기기 설정이라 남아야 하고, 나머지 계정별 키는 지워져야 한다.
 */
class MemoryStorage implements OwnerStorage {
  #map = new Map<string, string>()

  getItem(key: string) {
    return this.#map.has(key) ? this.#map.get(key)! : null
  }

  setItem(key: string, value: string) {
    this.#map.set(key, String(value))
  }

  removeItem(key: string) {
    this.#map.delete(key)
  }
}

describe('resetLocalAccount', () => {
  let storage: MemoryStorage

  beforeEach(async () => {
    // 테스트 사이에 남은 DB 를 지운다 — 앞 테스트의 문서가 다음 판정에 섞이지 않게
    await deleteLocalDatabase()
    storage = new MemoryStorage()
  })

  it('로컬 DB와 계정별 키를 지우고 새 계정 주인으로 바꾼 뒤 새로고침한다', async () => {
    await idbPut(STORES.documents, { id: 'doc-1', title: '지울 문서' })
    await idbPut(STORES.wordStates, { languageCode: 'en', lemma: 'run' })

    storage.setItem('lexi.purged', JSON.stringify(['doc-1']))
    storage.setItem('lexi.languages', JSON.stringify(['en', 'ja']))
    storage.setItem('lexi.syncState', JSON.stringify({ 'user-a': { version: 1 } }))
    // 기기 설정은 계정과 무관하다 — 테마·글자 크기까지 초기화하면 안 된다
    const settings = JSON.stringify({ theme: 'dark', textSize: 120 })
    storage.setItem('lexi.settings', settings)
    writeLocalOwner({ kind: 'local' }, storage)
    const reload = vi.fn()

    await resetLocalAccount('user-b', { storage, reload })

    await expect(idbGetAll(STORES.documents)).resolves.toEqual([])
    await expect(idbGetAll(STORES.wordStates)).resolves.toEqual([])

    expect(storage.getItem('lexi.purged')).toBeNull()
    expect(storage.getItem('lexi.languages')).toBeNull()
    expect(storage.getItem('lexi.syncState')).toBeNull()

    expect(storage.getItem(LOCAL_OWNER_KEY)).toBe(JSON.stringify({ kind: 'user', userId: 'user-b' }))
    expect(readLocalOwner(storage)).toEqual({ kind: 'user', userId: 'user-b' })

    expect(storage.getItem('lexi.settings')).toBe(settings)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  /**
   * `writeLocalOwner` 는 저장 실패를 삼킨다. 그대로 새로고침하면 소유자가 바뀌지
   * 않은 채 잠금 화면으로 돌아오고, 사용자는 초기화가 끝난 줄 안다. 소유자를
   * 다시 읽어 확인하지 못하면 성공으로 보고하지 않는다.
   */
  it('소유자를 저장하지 못하면 거절하고 새로고침하지 않는다', async () => {
    await idbPut(STORES.documents, { id: 'doc-1', title: '지울 문서' })
    writeLocalOwner({ kind: 'local' }, storage)
    const brokenStorage: OwnerStorage = {
      getItem: (key) => storage.getItem(key),
      setItem() {
        throw new Error('저장소를 쓸 수 없음')
      },
      removeItem: (key) => storage.removeItem(key),
    }
    const reload = vi.fn()

    await expect(resetLocalAccount('user-b', { storage: brokenStorage, reload })).rejects.toThrow(
      '계정 소유자 표시를 저장하지 못했습니다',
    )

    expect(readLocalOwner(brokenStorage)).toEqual({ kind: 'local', kept: false })
    expect(reload).not.toHaveBeenCalled()
  })
})
