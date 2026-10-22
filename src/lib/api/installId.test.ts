import { afterEach, describe, expect, it, vi } from 'vitest'

import { readOrCreateInstallId } from './installId'

/**
 * 설치 식별자는 계정 없이도 쓰는 이 기기의 이름표다.
 * 여기서 실패하면 번역 자체가 막히므로, 저장소가 아플 때도 값을 돌려줘야 한다.
 */

const KEY = 'lexi.installId'
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function memoryStorage(initial?: Record<string, string>) {
  const data = new Map(Object.entries(initial ?? {}))
  return {
    data,
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => void data.set(key, value)),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readOrCreateInstallId', () => {
  it('처음이면 UUID v4 를 만들어 저장한다', () => {
    const storage = memoryStorage()

    const id = readOrCreateInstallId(storage)

    expect(id).toMatch(UUID_V4)
    expect(storage.data.get(KEY)).toBe(id)
    expect(storage.setItem).toHaveBeenCalledWith(KEY, id)
  })

  it('저장된 ID 가 있으면 그대로 쓴다', () => {
    const saved = '123e4567-e89b-42d3-a456-426614174000'
    const storage = memoryStorage({ [KEY]: saved })

    expect(readOrCreateInstallId(storage)).toBe(saved)
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('망가진 값은 버리고 새로 만든다', () => {
    const storage = memoryStorage({ [KEY]: 'not-a-uuid' })

    const id = readOrCreateInstallId(storage)

    expect(id).toMatch(UUID_V4)
    expect(id).not.toBe('not-a-uuid')
    expect(storage.data.get(KEY)).toBe(id)
  })

  it('UUID 모양이지만 버전이 다른 값도 버린다', () => {
    // v6 UUID 는 이 정규식의 대상이 아니다
    const storage = memoryStorage({ [KEY]: '123e4567-e89b-62d3-a456-426614174000' })

    const id = readOrCreateInstallId(storage)

    expect(id).toMatch(UUID_V4)
    expect(id).not.toBe('123e4567-e89b-62d3-a456-426614174000')
  })

  it('읽기가 던져도 ID 를 돌려준다', () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error('SecurityError')
      }),
      setItem: vi.fn(),
    }

    expect(() => readOrCreateInstallId(storage)).not.toThrow()
    expect(readOrCreateInstallId(storage)).toMatch(UUID_V4)
  })

  it('쓰기가 던져도 ID 를 돌려준다', () => {
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error('QuotaExceededError')
      }),
    }

    expect(readOrCreateInstallId(storage)).toMatch(UUID_V4)
  })

  it('저장소를 넘기지 않으면 호출 시점의 localStorage 를 쓴다', () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)

    const id = readOrCreateInstallId()

    expect(id).toMatch(UUID_V4)
    expect(storage.data.get(KEY)).toBe(id)
  })

  it('localStorage 가 없는 환경에서도 던지지 않는다', () => {
    vi.stubGlobal('localStorage', undefined)

    expect(readOrCreateInstallId()).toMatch(UUID_V4)
  })
})
