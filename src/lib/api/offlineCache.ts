import {
  STORES,
  idbDelete,
  idbDeleteByIndexRange,
  idbGet,
  idbGetAll,
  idbPut,
} from '../storage/localDb'

/**
 * 번역·사전 응답의 기기 사본 (PLAN.md 결정 4 — "캐시된 번역/사전만 오프라인").
 *
 * 서버 쪽에 translation_cache / dictionary_entries 가 있어도, 그것을 보려면
 * 서버에 닿아야 한다. 지하철에서 곧장 읽으려면 받아 본 응답을 이 기기에도
 * 남겨 두는 수밖에 없다.
 *
 * 중요한 규칙 하나: **네트워크가 끊겨서 못 갔을 때만** 이 사본을 쓴다.
 * 서버가 "그런 단어 없다" 고 답한 경우를 오프라인 탓으로 돌리면 안 된다 —
 * 없는 단어를 있는 것처럼 보이는 훨씬 나쁜 오류이기 때문이다.
 */

/** 이 기기에 저장된 응답. 언제 저장됐는지 남겨야 나중에 지울 수 있다. */
export type CachedResponse<T> = {
  key: string
  value: T
  cachedAt: number
  /**
   * 값의 UTF-8 바이트 수 (선택).
   *
   * 크기 상한을 지키려면 행마다 크기를 알아야 한다. 저장할 때 한 번 세어 두면
   * 훑어볼 때 다시 직렬화하지 않아도 된다. 이 필드가 없는 예전 행은 읽을 때
   * 계산해서 센다.
   */
  size?: number
}

/** 마지막으로 읽은 뒤 이 기간이 지난 응답은 버린다 */
export const CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

/**
 * 회계를 DB 에서 다시 읽는 기준선 (20 MB).
 *
 * 회계는 탭마다 따로 산다. 두 탭이 각자 24 MB 를 쓰면 서로의 쓰기를 몰라
 * 합계 48 MB 가 될 수 있다. 자기 회계가 이 선을 넘으면 결정을 내리기 전에
 * IndexedDB 전체를 다시 세어 다른 탭의 몫까지 포함한다. 20 MB 위에서는 쓰기마다
 * 다시 세지만, 캐시가 그만큼 큰 경우는 드물고 상한이 지켜지는 편이 낫다.
 */
const CACHE_RECHECK_BYTES = 20 * 1024 * 1024

/**
 * 응답 캐시 전체 상한 (25 MB).
 *
 * **응답 캐시에만 적용한다.** 문서·단어 상태·등장 기록·폴더·묘비·투영·본문
 * 저장소는 학습 데이터라서 절대 지우지 않는다. 응답 캐시는 언제든 서버에서
 * 다시 받을 수 있는 유일한 종류다.
 *
 * 사전 zip(10.5 MB + 7.25 MB)은 OPFS 에 따로 있고 이 상한에 들어가지 않는다 —
 * 서로 다른 저장소이고, 사전은 학습 데이터처럼 다시 받으려면 큰 비용이 든다.
 *
 * 상한은 한 탭의 회계가 아니라 IndexedDB 전체의 합이다. 20 MB 를 넘는 쓰기는
 * 결정 전에 DB 에서 다시 세고, 탭 사이의 쓰기는 BroadcastChannel 로 알려
 * 상대 탭도 상한을 다시 확인한다 (CACHE_RECHECK_BYTES, cacheChannel 참고).
 */
export const CACHE_MAX_BYTES = 25 * 1024 * 1024

/**
 * 읽을 때마다 cachedAt 을 다시 쓰면 읽기가 느려진다. 최근 쓰인 것으로 보이게
 * 하려면 한 시간에 한 번이면 충분하다 — 90일 나이 기준에도 영향이 없다.
 */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000

const encoder = new TextEncoder()

function sizeOf(entry: { key: string; value: unknown }): number {
  try {
    return encoder.encode(JSON.stringify(entry.value)).length + encoder.encode(entry.key).length
  } catch {
    // 직렬화할 수 없는 값은 크기를 셀 수 없다 — 0 으로 두고 계속한다
    return 0
  }
}

function entrySize(row: CachedResponse<unknown>): number {
  return typeof row.size === 'number' && row.size >= 0 ? row.size : sizeOf(row)
}

/** 프로세스 안에서 센 바이트. 첫 쓰기에서 DB 를 한 번 훑어 맞춘 뒤 증분한다. */
let accountedBytes = 0
let knownSizes = new Map<string, number>()
let accountingLoaded = false

/**
 * 쓰기·정리를 한 줄로 세운다.
 *
 * 두 쓰기가 동시에 상한을 넘기면 둘 다 같은 오래된 행을 지우려 들 수 있다.
 * 회계 숫자도 서로 덮어쓰지 않도록 순서를 지킨다.
 */
let queue: Promise<unknown> = Promise.resolve()

function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task)
  queue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

async function loadAccounting(): Promise<void> {
  const rows = await idbGetAll<CachedResponse<unknown>>(STORES.responseCache)
  knownSizes = new Map(rows.map((row) => [row.key, entrySize(row)]))
  accountedBytes = rows.reduce((sum, row) => sum + entrySize(row), 0)
  accountingLoaded = true
}

/**
 * 저장이 끝난 뒤 회계를 맞춘다. 덮어쓴 경우 옛 크기와 새 크기의 차이만 더한다.
 *
 * 회계가 아직 안 읽혔다면 저장 뒤에 DB 를 훑으므로, 이 시점의 값이 곧 정답이다
 * (덮어쓴 예전 크기를 이중으로 세지 않는다).
 *
 * 다른 탭의 쓰기는 이 탭의 증분에 들어 있지 않다. 20 MB 를 넘으면 결정 전에
 * DB 에서 다시 세어, 두 탭이 각자 24 MB 를 써서 합계가 상한을 넘는 경우를 잡는다.
 */
async function accountWrite(key: string, nextBytes: number): Promise<void> {
  if (!accountingLoaded) {
    await loadAccounting()
    return
  }

  const previousBytes = knownSizes.get(key) ?? 0
  accountedBytes += nextBytes - previousBytes
  knownSizes.set(key, nextBytes)

  if (accountedBytes >= CACHE_RECHECK_BYTES) {
    // 결정 전에 DB 에서 다시 센다 — 다른 탭이 방금 쓴 것까지 포함해서.
    await loadAccounting()
  }
}

/**
 * 상한을 넘은 만큼 가장 오래된 것부터 지운다.
 *
 * 나이 기준(pruneCache)과 달리 상한은 쓰기 직후에도 확인한다 — 26 MB 를 쓴
 * 다음 날까지 그대로 두면 저장 공간이 먼저 바닥난다.
 */
async function evictOverflow(): Promise<number> {
  const rows = await idbGetAll<CachedResponse<unknown>>(STORES.responseCache)
  let total = rows.reduce((sum, row) => sum + entrySize(row), 0)
  knownSizes = new Map(rows.map((row) => [row.key, entrySize(row)]))

  if (total <= CACHE_MAX_BYTES) {
    accountedBytes = total
    accountingLoaded = true
    return 0
  }

  rows.sort((a, b) => a.cachedAt - b.cachedAt)
  let removed = 0
  for (const row of rows) {
    if (total <= CACHE_MAX_BYTES) break
    await idbDelete(STORES.responseCache, row.key)
    const rowBytes = entrySize(row)
    total -= rowBytes
    knownSizes.delete(row.key)
    removed += 1
  }

  accountedBytes = total
  accountingLoaded = true
  return removed
}

/**
 * 다른 탭에 "캐시가 바뀌었다" 고 알리는 채널.
 *
 * 상한은 결국 하나의 IndexedDB 를 나눠 쓰는 여러 탭의 합이다. 자기 회계가
 * 20 MB 를 넘을 때만 다시 세면, 작은 몫을 가진 탭은 다른 탭이 키운 것을
 * 모를 수 있다. 쓰기가 있을 때마다 알려 상대 탭의 회계를 무효화하고,
 * 상대 탭은 지금 캐시 전체를 다시 세어 상한을 넘었으면 즉시 줄인다.
 * 브라우저에 BroadcastChannel 이 없으면 조용히 넘어간다 — 다음 쓰기의
 * 재확인이 안전망이다.
 */
const CACHE_CHANNEL = 'lexi.responseCache'

let channel: BroadcastChannel | null = null

function cacheChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null
  if (!channel) {
    channel = new BroadcastChannel(CACHE_CHANNEL)
    channel.onmessage = () => {
      // 이 탭의 증분은 다른 탭의 쓰기를 모른다 — 다음 결정 전에 다시 센다
      accountingLoaded = false
      void serial(async () => {
        const removed = await evictOverflow().catch(() => 0)
        if (removed > 0) notifyCacheChanged()
      })
    }
  }
  return channel
}

function notifyCacheChanged(): void {
  try {
    cacheChannel()?.postMessage('changed')
  } catch {
    // 알림 실패는 캐시 동작에 영향이 없다
  }
}

export function cacheKey(...parts: (string | number)[]): string {
  return parts.join('\u0000')
}

/**
 * 서버에 닿지 못한 실패인가.
 *
 * HTTP 상태가 있으면 서버가 답한 것이라 오프라인이 아니다. 상태 없이 실패한
 * 경우(DNS·연결·오프라인 등)만 이 기기 사본으로 대신할 수 있다.
 */
export function isTransportFailure(status?: number): boolean {
  return status === undefined || status === 0
}

export async function readCached<T>(key: string): Promise<CachedResponse<T> | undefined> {
  try {
    const row = await idbGet<CachedResponse<T>>(STORES.responseCache, key)
    if (!row) return undefined

    // 최근에 읽은 응답은 나중에 지워지도록 시각만 갱신한다 (진짜 LRU).
    // 값은 그대로 두므로 바이트 회계는 바뀌지 않는다.
    const now = Date.now()
    if (Number.isFinite(row.cachedAt) && now - row.cachedAt > TOUCH_INTERVAL_MS) {
      void serial(async () => {
        // 큐에서 기다리는 사이 다른 쓰기(또는 다른 탭)가 행을 바꿨을 수 있다.
        // 처음 읽은 스냅숏을 되쓰면 새 값을 덮어쓴다 — 지금 행을 다시 읽는다.
        const current = await idbGet<CachedResponse<T>>(STORES.responseCache, key)
        if (!current) return
        const touchedAt = Date.now()
        if (Number.isFinite(current.cachedAt) && touchedAt - current.cachedAt > TOUCH_INTERVAL_MS) {
          await idbPut<CachedResponse<T>>(STORES.responseCache, {
            ...current,
            cachedAt: touchedAt,
          })
        }
      }).catch(() => {
        // 최근 사용 표시 실패는 캐시 읽기 자체를 망치지 않는다
      })
    }

    return row
  } catch {
    // 캐시를 못 읽어도 앱은 계속 돌아야 한다
    return undefined
  }
}

/**
 * 저장한다. 실패해도 절대 던지지 않는다.
 *
 * 화면에 이미 결과가 나와 있는 데, 캐시 저장 실패로 그 결과를 잃으면 안 된다.
 * 저장 뒤 상한을 넘었으면 가장 오래된 응답부터 버린다.
 */
export async function writeCached<T>(key: string, value: T): Promise<void> {
  try {
    const size = sizeOf({ key, value })
    // 저장은 바로 시작한다 — 미루면 방금 받은 응답이 잠시 캐시에 없는 상태가 된다.
    await idbPut<CachedResponse<T>>(STORES.responseCache, {
      key,
      value,
      cachedAt: Date.now(),
      size,
    })

    await serial(async () => {
      await accountWrite(key, size)
      if (accountedBytes > CACHE_MAX_BYTES) await evictOverflow()
    })
    notifyCacheChanged()
  } catch {
    // 조용히 넘긴다 — 캐시는 부가 기능이다
  }
}

/**
 * 오래된 것과 상한을 넘긴 것을 버린다. 앱을 열 때 한 번 부른다.
 *
 * 두 기준은 따로 돈다 — 나이 삭제가 실패해도 크기 상한은 지킨다.
 */
export async function pruneCache(now = Date.now()): Promise<number> {
  return serial(async () => {
    let removed = 0
    try {
      removed += await idbDeleteByIndexRange(
        STORES.responseCache,
        'cachedAt',
        now - CACHE_MAX_AGE_MS,
      )
    } catch {
      // 나이 삭제가 실패해도 아래 크기 정리는 계속한다
    }

    try {
      removed += await evictOverflow()
    } catch {
      // 캐시 정리 실패는 앱 시작을 막지 않는다
    }

    if (removed > 0) notifyCacheChanged()
    return removed
  }).catch(() => 0)
}

/**
 * 서버에 물어보고, 닿지 못하면 이 기기 사본을 돌려준다.
 *
 * `request` 가 서버 응답을 그대로 던지는 함수여야 한다 — 여기서 4xx 를 캐시로
 * 대신하면 "없다" 는 정답이 "있다" 로 바뀌어 버린다.
 */
export async function fetchOrCached<T>(
  key: string,
  request: () => Promise<T>,
  statusOf: (error: unknown) => number | undefined,
): Promise<{ value: T; fromCache: boolean }> {
  try {
    const value = await request()
    void writeCached(key, value)
    return { value, fromCache: false }
  } catch (error) {
    if (!isTransportFailure(statusOf(error))) throw error

    const cached = await readCached<T>(key)
    if (!cached) throw error

    return { value: cached.value, fromCache: true }
  }
}
