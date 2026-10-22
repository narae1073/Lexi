import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  LOCAL_OWNER_KEY,
  clearLocalOwner,
  ensureLocalOwner,
  readLocalOwner,
  resolveAccountScope,
  writeLocalOwner,
  type OwnerStorage,
} from './accountOwner'

/**
 * jsdom 이 없으므로 저장 계약만 만족하는 스텁을 세운다.
 * 계정 소유자 표시는 '이 기기가 어느 계정의 것인가' 를 기억하는 순수한 값이다.
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

function explodingGet(storage: MemoryStorage): OwnerStorage {
  return {
    getItem() {
      throw new Error('저장소를 읽을 수 없음')
    },
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: (key) => storage.removeItem(key),
  }
}

function explodingWrite(): OwnerStorage {
  return {
    getItem() {
      return null
    },
    setItem() {
      throw new Error('저장소를 쓸 수 없음')
    },
    removeItem() {
      throw new Error('저장소를 지울 수 없음')
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('계정 소유자 표시', () => {
  it('저장 키는 lexi.localOwner 다', () => {
    expect(LOCAL_OWNER_KEY).toBe('lexi.localOwner')
  })

  it('저장된 것이 없으면 null 이다', () => {
    expect(readLocalOwner(new MemoryStorage())).toBeNull()
  })

  it('기기 소유자를 적고 다시 읽는다', () => {
    const storage = new MemoryStorage()

    writeLocalOwner({ kind: 'local' }, storage)

    expect(readLocalOwner(storage)).toEqual({ kind: 'local', kept: false })
  })

  /**
   * '이 기기만 쓰기' 를 고른 결과는 새로 고침 뒤에도 다시 묻지 않아야 한다.
   * 그래서 kept: true 를 그대로 기억한다.
   */
  it('kept: true 를 기억한다', () => {
    const storage = new MemoryStorage()

    writeLocalOwner({ kind: 'local', kept: true }, storage)

    expect(readLocalOwner(storage)).toEqual({ kind: 'local', kept: true })
  })

  it('kept 가 true 가 아니면 false 로 정규화한다', () => {
    const storage = new MemoryStorage()
    storage.setItem(LOCAL_OWNER_KEY, JSON.stringify({ kind: 'local', kept: 'yes' }))

    expect(readLocalOwner(storage)).toEqual({ kind: 'local', kept: false })
  })

  it('계정 소유자를 적고 다시 읽는다', () => {
    const storage = new MemoryStorage()

    writeLocalOwner({ kind: 'user', userId: 'user-a' }, storage)

    expect(readLocalOwner(storage)).toEqual({ kind: 'user', userId: 'user-a' })
    expect(storage.getItem(LOCAL_OWNER_KEY)).toBe(
      JSON.stringify({ kind: 'user', userId: 'user-a' }),
    )
  })

  it('망가진 JSON 은 없는 것으로 본다', () => {
    const storage = new MemoryStorage()
    storage.setItem(LOCAL_OWNER_KEY, 'not json')

    expect(readLocalOwner(storage)).toBeNull()
  })

  it.each([
    ['알 수 없는 kind', JSON.stringify({ kind: 'team', userId: 'user-a' })],
    ['kind 없음', JSON.stringify({ userId: 'user-a' })],
    ['user 인데 userId 없음', JSON.stringify({ kind: 'user' })],
    ['user 인데 userId 가 빈 문자열', JSON.stringify({ kind: 'user', userId: '' })],
    ['user 인데 userId 가 문자열이 아님', JSON.stringify({ kind: 'user', userId: 42 })],
    ['배열', JSON.stringify([{ kind: 'local' }])],
    ['null', 'null'],
    ['문자열', JSON.stringify('local')],
  ])('%s 이면 null 이다', (_label, raw) => {
    const storage = new MemoryStorage()
    storage.setItem(LOCAL_OWNER_KEY, raw)

    expect(readLocalOwner(storage)).toBeNull()
  })

  it('저장소를 읽지 못해도 던지지 않고 null 을 준다', () => {
    expect(readLocalOwner(explodingGet(new MemoryStorage()))).toBeNull()
  })

  it('저장소를 쓰지 못해도 던지지 않는다', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => writeLocalOwner({ kind: 'local', kept: true }, explodingWrite())).not.toThrow()
    expect(error).toHaveBeenCalled()
  })

  it('저장소를 지우지 못해도 던지지 않는다', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => clearLocalOwner(explodingWrite())).not.toThrow()
    expect(error).toHaveBeenCalled()
  })

  it('지우면 없어진다', () => {
    const storage = new MemoryStorage()
    writeLocalOwner({ kind: 'user', userId: 'user-a' }, storage)

    clearLocalOwner(storage)

    expect(readLocalOwner(storage)).toBeNull()
  })

  it('저장소를 넘기지 않으면 globalThis.localStorage 를 쓴다', () => {
    const storage = new MemoryStorage()
    const globals = globalThis as { localStorage?: Storage }
    const original = globals.localStorage
    globals.localStorage = storage as unknown as Storage

    try {
      writeLocalOwner({ kind: 'local', kept: true })
      expect(readLocalOwner()).toEqual({ kind: 'local', kept: true })
      clearLocalOwner()
      expect(readLocalOwner()).toBeNull()
    } finally {
      if (original === undefined) delete globals.localStorage
      else globals.localStorage = original
    }
  })
})

describe('계정 범위 판정', () => {
  it('로그아웃 상태면 기기 범위다 — 소유자와 기기 데이터와 무관하다', () => {
    expect(
      resolveAccountScope({ owner: null, userId: null, hasLocalData: false }),
    ).toBe('local')
    expect(
      resolveAccountScope({ owner: null, userId: null, hasLocalData: true }),
    ).toBe('local')
    expect(
      resolveAccountScope({
        owner: { kind: 'user', userId: 'user-a' },
        userId: null,
        hasLocalData: true,
      }),
    ).toBe('local')
    expect(
      resolveAccountScope({
        owner: { kind: 'local', kept: true },
        userId: null,
        hasLocalData: true,
      }),
    ).toBe('local')
  })

  it('소유자 표시가 없고 기기 데이터도 없으면 동기화한다', () => {
    expect(
      resolveAccountScope({ owner: null, userId: 'user-a', hasLocalData: false }),
    ).toBe('sync')
  })

  it('소유자 표시가 없지만 기기 데이터가 있으면 넘겨받을지 묻는다', () => {
    expect(
      resolveAccountScope({ owner: null, userId: 'user-a', hasLocalData: true }),
    ).toBe('claim')
  })

  it('아직 넘겨받지 않은 기기 소유자는 기기 데이터가 없으면 동기화한다', () => {
    expect(
      resolveAccountScope({
        owner: { kind: 'local' },
        userId: 'user-a',
        hasLocalData: false,
      }),
    ).toBe('sync')
    expect(
      resolveAccountScope({
        owner: { kind: 'local', kept: false },
        userId: 'user-a',
        hasLocalData: false,
      }),
    ).toBe('sync')
  })

  it('아직 넘겨받지 않은 기기 소유자는 기기 데이터가 있으면 넘겨받을지 묻는다', () => {
    expect(
      resolveAccountScope({
        owner: { kind: 'local' },
        userId: 'user-a',
        hasLocalData: true,
      }),
    ).toBe('claim')
    expect(
      resolveAccountScope({
        owner: { kind: 'local', kept: false },
        userId: 'user-a',
        hasLocalData: true,
      }),
    ).toBe('claim')
  })

  /**
   * '이 기기만 쓰기' 는 이미 내린 결정이다. 새로 고침할 때마다 다시 묻지 않는다.
   * 아직 넘겨받지 않은 기기 소유자(kept 없음/false)와는 다른 상태다.
   */
  it('이 기기만 쓰기를 고른 소유자는 기기 데이터와 무관하게 다시 묻지 않는다', () => {
    expect(
      resolveAccountScope({
        owner: { kind: 'local', kept: true },
        userId: 'user-a',
        hasLocalData: false,
      }),
    ).toBe('local')
    expect(
      resolveAccountScope({
        owner: { kind: 'local', kept: true },
        userId: 'user-a',
        hasLocalData: true,
      }),
    ).toBe('local')
  })

  it('같은 계정의 소유자 표시면 동기화한다', () => {
    expect(
      resolveAccountScope({
        owner: { kind: 'user', userId: 'user-a' },
        userId: 'user-a',
        hasLocalData: false,
      }),
    ).toBe('sync')
    expect(
      resolveAccountScope({
        owner: { kind: 'user', userId: 'user-a' },
        userId: 'user-a',
        hasLocalData: true,
      }),
    ).toBe('sync')
  })

  /**
   * 다른 계정의 데이터가 이 기기에 남아 있다. 그 데이터를 새 계정으로 올리면
   * 남의 기록이 섞인다 — 그래서 막는다.
   */
  it('다른 계정의 소유자 표시면 막는다', () => {
    expect(
      resolveAccountScope({
        owner: { kind: 'user', userId: 'user-a' },
        userId: 'user-b',
        hasLocalData: false,
      }),
    ).toBe('blocked')
    expect(
      resolveAccountScope({
        owner: { kind: 'user', userId: 'user-a' },
        userId: 'user-b',
        hasLocalData: true,
      }),
    ).toBe('blocked')
  })
})

/**
 * 기기 데이터가 있는지는 이 모듈이 직접 알 수 없다 — IndexedDB 를 모르는 순수한
 * 파일로 남기려고 호출자가 `hasLocalData` 로 넣어 준다.
 *
 * 핵심은 '자동으로 넘겨받지 않는다' 이다. 로그인한 계정이 그 기기 기록의 주인인지
 * 알 수 없으므로, 데이터가 있으면 물어보는 상태(local, kept 없음)로 남긴다.
 */
describe('기기 소유자 초기화', () => {
  it('소유자도 기기 데이터도 없으면 로그인한 계정으로 적는다', async () => {
    const storage = new MemoryStorage()
    const hasLocalData = vi.fn(async () => false)

    const owner = await ensureLocalOwner('user-a', { storage, hasLocalData })

    expect(owner).toEqual({ kind: 'user', userId: 'user-a' })
    expect(readLocalOwner(storage)).toEqual({ kind: 'user', userId: 'user-a' })
    expect(hasLocalData).toHaveBeenCalledTimes(1)
  })

  it('소유자는 없지만 기기 데이터가 있으면 넘겨받기를 기다린다 — 자동으로 붙이지 않는다', async () => {
    const storage = new MemoryStorage()

    const owner = await ensureLocalOwner('user-a', {
      storage,
      hasLocalData: async () => true,
    })

    expect(owner).toEqual({ kind: 'local' })
    expect(readLocalOwner(storage)).toEqual({ kind: 'local', kept: false })
  })

  it('로그아웃 상태로 소유자가 없으면 기기 소유자로 적는다', async () => {
    const storage = new MemoryStorage()

    const owner = await ensureLocalOwner(null, { storage, hasLocalData: async () => true })

    expect(owner).toEqual({ kind: 'local' })
    expect(readLocalOwner(storage)).toEqual({ kind: 'local', kept: false })
  })

  it('아직 넘겨받지 않은 기기 소유자는 기기 데이터가 없으면 계정으로 올린다', async () => {
    const storage = new MemoryStorage()
    writeLocalOwner({ kind: 'local', kept: false }, storage)
    const hasLocalData = vi.fn(async () => false)

    const owner = await ensureLocalOwner('user-a', { storage, hasLocalData })

    expect(owner).toEqual({ kind: 'user', userId: 'user-a' })
    expect(readLocalOwner(storage)).toEqual({ kind: 'user', userId: 'user-a' })
    expect(hasLocalData).toHaveBeenCalledTimes(1)
  })

  it('아직 넘겨받지 않은 기기 소유자는 기기 데이터가 있으면 그대로 둔다', async () => {
    const storage = new MemoryStorage()
    writeLocalOwner({ kind: 'local', kept: false }, storage)

    const owner = await ensureLocalOwner('user-a', {
      storage,
      hasLocalData: async () => true,
    })

    expect(owner).toEqual({ kind: 'local', kept: false })
    expect(readLocalOwner(storage)).toEqual({ kind: 'local', kept: false })
  })

  it('이 기기만 쓰기를 고른 소유자는 기기 데이터가 없어도 계정으로 바꾸지 않는다', async () => {
    const storage = new MemoryStorage()
    writeLocalOwner({ kind: 'local', kept: true }, storage)

    const owner = await ensureLocalOwner('user-a', {
      storage,
      hasLocalData: async () => false,
    })

    expect(owner).toEqual({ kind: 'local', kept: true })
    expect(readLocalOwner(storage)).toEqual({ kind: 'local', kept: true })
  })

  it('계정 소유자 표시는 같은 계정이든 다른 계정이든 바꾸지 않는다', async () => {
    const storage = new MemoryStorage()
    writeLocalOwner({ kind: 'user', userId: 'user-a' }, storage)

    expect(
      await ensureLocalOwner('user-a', { storage, hasLocalData: async () => true }),
    ).toEqual({ kind: 'user', userId: 'user-a' })
    expect(
      await ensureLocalOwner('user-b', { storage, hasLocalData: async () => true }),
    ).toEqual({ kind: 'user', userId: 'user-a' })
    expect(readLocalOwner(storage)).toEqual({ kind: 'user', userId: 'user-a' })
  })

  /**
   * 기기 데이터 확인이 실패하면 '데이터가 있을 수도 있다' 로 본다. 여기서
   * 계정에 붙이거나 기기 표시를 지우면 남의 기록이 섞이거나 사라질 수 있다.
   */
  it('기기 데이터 확인이 실패하면 기기 소유자로 남긴다', async () => {
    const throwing = async () => {
      throw new Error('IndexedDB 를 읽을 수 없음')
    }

    const empty = new MemoryStorage()
    expect(await ensureLocalOwner('user-a', { storage: empty, hasLocalData: throwing })).toEqual({
      kind: 'local',
    })

    const unclaimed = new MemoryStorage()
    writeLocalOwner({ kind: 'local', kept: false }, unclaimed)
    expect(
      await ensureLocalOwner('user-a', { storage: unclaimed, hasLocalData: throwing }),
    ).toEqual({ kind: 'local', kept: false })
    expect(readLocalOwner(unclaimed)).toEqual({ kind: 'local', kept: false })
  })

  it('기기 소유자를 적지 못해도 계산한 소유자를 돌려준다', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const owner = await ensureLocalOwner('user-a', {
      storage: explodingWrite(),
      hasLocalData: async () => false,
    })

    expect(owner).toEqual({ kind: 'user', userId: 'user-a' })
    expect(error).toHaveBeenCalled()
  })
})
