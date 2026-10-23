import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 응답 캐시 상한 회귀 테스트.
 *
 * R3 는 200k 규모를 다룬다. 번역·사전 응답은 계속 쌓이므로 나이(90일)만으로는
 * 부족하다 — 기기 저장 공간에는 한계가 있고, 응답 캐시는 언제든 다시 받을 수
 * 있는 유일한 종류의 데이터다. 반면 학습 데이터(문서·단어 상태·등장 기록)는
 * 여기서 절대 지우면 안 된다.
 */

const db = vi.hoisted(() => {
  type Row = { key: string; cachedAt: number; size?: number; value?: unknown }
  const rows = new Map<string, Row>()
  return {
    rows,
    idbGet: vi.fn(async (_store: string, key: string) => rows.get(key)),
    idbPut: vi.fn(async (_store: string, row: Row) => {
      rows.set(row.key, row)
      return row.key
    }),
    idbDelete: vi.fn(async (_store: string, key: string) => {
      rows.delete(key)
    }),
    idbGetAll: vi.fn(async (_store: string) => [...rows.values()]),
    idbDeleteByIndexRange: vi.fn(
      async (_store: string, _index: string, upperBound: number) => {
        let removed = 0
        for (const [key, row] of rows) {
          if (row.cachedAt <= upperBound) {
            rows.delete(key)
            removed += 1
          }
        }
        return removed
      },
    ),
  }
})

vi.mock('../storage/localDb', () => ({
  STORES: { responseCache: 'responseCache' },
  idbGet: db.idbGet,
  idbPut: db.idbPut,
  idbDelete: db.idbDelete,
  idbGetAll: db.idbGetAll,
  idbDeleteByIndexRange: db.idbDeleteByIndexRange,
}))

const MB = 1024 * 1024
const T0 = new Date('2026-01-01T00:00:00Z').getTime()

/** 모듈 안의 바이트 회계 상태를 초기화하려고 매번 새로 불러온다 */
async function loadCache() {
  vi.resetModules()
  return import('./offlineCache')
}

function payload(megabytes: number): string {
  return 'x'.repeat(megabytes * MB)
}

describe('responseCache 상한', () => {
  beforeEach(() => {
    db.rows.clear()
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('상한은 25 MB 다', async () => {
    const { CACHE_MAX_BYTES } = await loadCache()
    expect(CACHE_MAX_BYTES).toBe(25 * MB)
  })

  it('25 MB 를 넘기면 가장 오래된 것부터 버리고 최근 것은 남긴다', async () => {
    const { writeCached } = await loadCache()

    vi.setSystemTime(T0)
    await writeCached('old', payload(9))
    vi.setSystemTime(T0 + 1_000)
    await writeCached('middle', payload(9))
    vi.setSystemTime(T0 + 2_000)
    await writeCached('new', payload(9))

    expect(db.rows.has('old')).toBe(false)
    expect(db.rows.has('middle')).toBe(true)
    expect(db.rows.has('new')).toBe(true)
  })

  it('90일이 지난 응답은 크기와 무관하게 버린다', async () => {
    const { pruneCache, writeCached } = await loadCache()
    await writeCached('stale', { found: true })

    const ninetyOneDays = 91 * 24 * 60 * 60 * 1000
    const removed = await pruneCache(T0 + ninetyOneDays)

    expect(removed).toBe(1)
    expect(db.rows.size).toBe(0)
  })

  it('상한 안이면 오래된 응답도 남긴다', async () => {
    const { pruneCache, writeCached } = await loadCache()
    await writeCached('a', { found: true })
    vi.setSystemTime(T0 + 1_000)
    await writeCached('b', { found: true })

    const removed = await pruneCache(T0 + 2_000)

    expect(removed).toBe(0)
    expect([...db.rows.keys()].sort()).toEqual(['a', 'b'])
  })

  it('같은 키를 다시 쓰면 바이트를 두 번 세지 않는다', async () => {
    const { writeCached } = await loadCache()

    await writeCached('same', payload(20))
    vi.setSystemTime(T0 + 1_000)
    await writeCached('same', { found: true })
    vi.setSystemTime(T0 + 2_000)
    await writeCached('other', payload(20))

    // 20 MB + 작은 값 + 20 MB 는 상한 아래다 — 덮어쓴 옛 크기를 계속 세면 여기서 지워진다
    expect(db.rows.has('same')).toBe(true)
    expect(db.rows.has('other')).toBe(true)
  })

  it('pruneCache 도 상한을 적용한다 — 앱 시작 시 남은 큰 캐시를 정리한다', async () => {
    const { pruneCache } = await loadCache()
    // 지난 버전이 남긴 행에는 size 가 없을 수 있다 — 캐시가 직접 계산해야 한다
    db.rows.set('big-old', { key: 'big-old', value: payload(20), cachedAt: T0 })
    db.rows.set('big-new', { key: 'big-new', value: payload(20), cachedAt: T0 + 1_000 })

    const removed = await pruneCache(T0 + 2_000)

    expect(removed).toBe(1)
    expect(db.rows.has('big-old')).toBe(false)
    expect(db.rows.has('big-new')).toBe(true)
  })

  it('두 탭이 각자 써도 상한을 넘기 전에 DB 에서 다시 센다', async () => {
    // 두 모듈 인스턴스 = 두 탭. 같은 IndexedDB(row Map)를 공유한다.
    const tabB = await loadCache()
    const tabA = await loadCache()

    // B 가 먼저 회계를 읽어 둔다 — 이후 A 의 쓰기를 모르는 상태가 된다
    await tabB.writeCached('b1', payload(6))

    // A 는 B 의 몫을 모른 채 자기 18 MB 를 더 쓴다
    await tabA.writeCached('a1', payload(6))
    await tabA.writeCached('a2', payload(6))
    await tabA.writeCached('a3', payload(6))

    // B 의 증분만 보면 6 + 18 = 24 MB 로 상한 아래지만 실제 합계는 42 MB 다.
    // B 가 20 MB 를 넘는 순간 DB 를 다시 세어 상한까지 지워야 한다.
    await tabB.writeCached('b2', payload(6))
    await tabB.writeCached('b3', payload(6))
    await tabB.writeCached('b4', payload(6))

    const total = [...db.rows.values()].reduce(
      (sum, row) => sum + (row.size ?? 0),
      0,
    )
    expect(total).toBeLessThanOrEqual(25 * MB)
    expect(db.rows.size).toBeLessThan(7)
  })

  it('읽기 touch 는 큐 안에서 다시 읽어 새 값을 덮어쓰지 않는다', async () => {
    vi.useRealTimers()
    const { readCached } = await loadCache()

    const staleAt = Date.now() - 2 * 60 * 60 * 1000
    db.rows.set('k', {
      key: 'k',
      value: { version: 1 },
      cachedAt: staleAt,
      size: 10,
    })

    // touch 의 재읽기를 붙잡아 두고, 그 사이 새 값이 저장되는 상황을 만든다
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = db.idbGet.getMockImplementation()!
    let calls = 0
    db.idbGet.mockImplementation(async (store: string, key: string) => {
      calls += 1
      if (calls === 2) await gate
      return original(store, key)
    })

    try {
      const reading = readCached<{ version: number }>('k')
      await vi.waitFor(() => expect(calls).toBe(2))

      // touch 가 기다리는 사이 다른 쓰기가 새 값을 저장했다
      db.rows.set('k', {
        key: 'k',
        value: { version: 2 },
        cachedAt: Date.now(),
        size: 10,
      })
      release()
      await reading
      await new Promise((resolve) => setTimeout(resolve, 0))

      // 옛 스냅숏을 되썼다면 version 1 이 살아난다
      expect(db.rows.get('k')?.value).toEqual({ version: 2 })
    } finally {
      db.idbGet.mockImplementation(original)
    }
  })

  it('학습 데이터 저장소는 건드리지 않는다', async () => {
    const { writeCached } = await loadCache()

    await writeCached('a', payload(20))
    vi.setSystemTime(T0 + 1_000)
    await writeCached('b', payload(20))

    expect(db.idbDelete).toHaveBeenCalled()
    for (const call of db.idbDelete.mock.calls) {
      expect(call[0]).toBe('responseCache')
    }
    for (const call of db.idbGetAll.mock.calls) {
      expect(call[0]).toBe('responseCache')
    }
  })
})
