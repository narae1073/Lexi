import { describe, expect, it, vi } from 'vitest'

import { cacheKey, fetchOrCached, isTransportFailure } from './offlineCache'

/**
 * 회귀 테스트.
 *
 * 이 모듈의 핵심은 "언제 이 기기 사본으로 대신해도 되는가" 다.
 * 잘못 허용하면 서버가 "그런 단어 없다" 고 한 것을 "있다" 고showing 버리는
 * 훨씬 나쁜 오류가 된다.
 */

// IndexedDB 를 실제로 쓰지 않는다 — 이 모듈의 위험은 저장보다 "언제 대신할 것인가" 다.
const idb = vi.hoisted(() => {
  const store = new Map<string, unknown>()
  return {
    store,
    readCached: vi.fn(async (key: string) => store.get(key)),
    writeCached: vi.fn(async (key: string, value: unknown) => void store.set(key, value)),
  }
})

vi.mock('../storage/localDb', () => ({
  STORES: { responseCache: 'responseCache' },
  idbGet: idb.readCached,
  idbPut: idb.writeCached,
  idbDeleteByIndexRange: vi.fn(async () => 0),
}))

const statusOf = (e: unknown) => (e as { status?: number }).status

const offline = new Error('Failed to fetch')
const serverSaid404 = Object.assign(new Error('Not found'), { status: 404 })
const serverSaid500 = Object.assign(new Error('boom'), { status: 500 })

describe('isTransportFailure', () => {
  it('상태가 없으면 서버에 닿지 못한 것이다', () => {
    expect(isTransportFailure(undefined)).toBe(true)
    expect(isTransportFailure(0)).toBe(true)
  })

  it('상태가 있으면 서버가 답한 것이다', () => {
    expect(isTransportFailure(404)).toBe(false)
    expect(isTransportFailure(500)).toBe(false)
  })
})

describe('cacheKey', () => {
  it('빈 칸으로 이어 붙여 앞뒤가 섞이지 않는다', () => {
    // 구분자가 없으면 'a' + 'bc' 와 'ab' + 'c' 가 같은 키가 된다
    expect(cacheKey('a', 'bc')).not.toBe(cacheKey('ab', 'c'))
  })

  it('같은 값이면 같은 키다', () => {
    expect(cacheKey('de', 'Häuser', 'Häuser')).toBe(cacheKey('de', 'Häuser', 'Häuser'))
  })
})

describe('fetchOrCached', () => {

  it('서버가 답하면 그 답을 쓰고 저장한다', async () => {
    idb.store.clear()
    const request = vi.fn(async () => ({ found: true }))
    const result = await fetchOrCached('k', request, statusOf)

    expect(result).toEqual({ value: { found: true }, fromCache: false })
    // 저장은 의도적으로 뒤로 미룬다 — 화면에 이미 나온 결과를 캐시 때문에 잃으면 안 된다
    expect(idb.writeCached).toHaveBeenCalledWith(
      'responseCache',
      expect.objectContaining({ key: 'k', value: { found: true } }),
    )
    const stored = idb.writeCached.mock.calls[0][1] as { cachedAt?: unknown }
    expect(stored.cachedAt).toBeTypeOf('number')
  })

  it('네트워크가 끊겼고 사본이 있으면 그것을 돌려준다', async () => {
    idb.store.clear()
    await fetchOrCached('k', async () => ({ found: true }), statusOf)
    idb.writeCached.mockClear()

    const result = await fetchOrCached('k', async () => Promise.reject(offline), statusOf)
    expect(result.fromCache).toBe(true)
    expect(result.value).toEqual({ found: true })
  })

  it('404 는 사본으로 대신하지 않는다 — 없는 단어가 있는 것처럼 보이면 안 된다', async () => {
    idb.store.clear()
    await fetchOrCached('k', async () => ({ found: false }), statusOf)

    await expect(
      fetchOrCached('k', async () => Promise.reject(serverSaid404), statusOf),
    ).rejects.toThrow('Not found')
  })

  it('500 도 사본으로 대신하지 않는다 — 서버가 살아 있는데 오류가 났다', async () => {
    idb.store.clear()
    await fetchOrCached('k', async () => ({ found: false }), statusOf)

    await expect(
      fetchOrCached('k', async () => Promise.reject(serverSaid500), statusOf),
    ).rejects.toThrow('boom')
  })

  it('끊겼는데 사본도 없으면 원래 오류를 그대로 낸다', async () => {
    idb.store.clear()
    await expect(
      fetchOrCached('missing', async () => Promise.reject(offline), statusOf),
    ).rejects.toThrow('Failed to fetch')
  })

  it('사본으로 대신할 때 서버에 다시 쓰지 않는다', async () => {
    idb.store.clear()
    await fetchOrCached('k', async () => ({ found: true }), statusOf)
    idb.writeCached.mockClear()

    await fetchOrCached('k', async () => Promise.reject(offline), statusOf)
    expect(idb.writeCached).not.toHaveBeenCalled()
  })
})
