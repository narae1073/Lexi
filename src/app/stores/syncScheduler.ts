/**
 * 저장后排기 — "바뀌었으니 곧바로 서버로 보낸다" 의 타이밍을 정하는 곳.
 *
 * 순수 로직으로 떼어 뒀다. 타이머와 상태만 알면 되므로 가짜 시계로 시험할 수 있고,
 * 이 타이밍을 바꿀 때마다 계정을 로그인시켜 확인하지 않아도 된다.
 *
 * 왜 이게 중요한가: 예전에는 동기화가 로그인·앱 시작·온라인 복귀에만 돌았다.
 * 단어 상태를 바꿔도 아무도 서버에 알리지 않아, 창을 X 로 닫으면 그 변경은 서버에
 * 없던 것이었다. 새로고침해야 올라가는 것처럼 보였던 이유가 이것이다.
 */
export type SyncSchedulerOptions = {
  /** 실제로 서버로 보내는 일. 오래 걸려도 된다 */
  flush: () => Promise<void>
  /** 아무것도 안 바꾸고 이만큼 지나면 보낸다 */
  debounceMs: number
  /** 계속 바꿔도 이만큼 지나면 반드시 한 번은 보낸다 */
  maxWaitMs: number
}

export type SyncScheduler = {
  /** 바뀐 것이 있다고 알린다 — 즉시 보내지 않고 시간을 잰다 */
  notify: () => void
  /** 남은 것을 지금 보낸다. 기다린 시간이 있어도 바로 */
  flushNow: () => void
  /** 서버에 아직 안 올라간 변경이 남아 있는가 */
  readonly pending: boolean
  /** 밀린 변경 수 */
  readonly count: number
  dispose: () => void
}

export function createSyncScheduler({
  flush,
  debounceMs,
  maxWaitMs,
}: SyncSchedulerOptions): SyncScheduler {
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let maxWaitTimer: ReturnType<typeof setTimeout> | undefined
  let running = false
  /** 보낸 뒤에 도착한 변화 — 놓치면 서버에 없는 상태로 남는다 */
  let queued = false
  let count = 0

  const cancelTimers = () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    if (maxWaitTimer) clearTimeout(maxWaitTimer)
    debounceTimer = undefined
    maxWaitTimer = undefined
  }

  const run = async () => {
    if (running) {
      // 보낸 사이에 쌓인 것을 버리지 않는다
      queued = true
      return
    }
    running = true
    // 지금까지 쌓인 것은 이번에 보낸다 — 보낸 뒤 도착한 것은 다시 쌓인다
    count = 0
    try {
      await flush()
    } finally {
      running = false
      if (queued) {
        queued = false
        void run()
      }
    }
  }

  return {
    notify: () => {
      count += 1

      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        cancelTimers()
        void run()
      }, debounceMs)

      // 미루기만 하다가 끝내 보내지 않는 일을 막는다
      if (!maxWaitTimer) {
        maxWaitTimer = setTimeout(() => {
          cancelTimers()
          void run()
        }, maxWaitMs)
      }
    },

    flushNow: () => {
      if (count === 0) return
      cancelTimers()
      void run()
    },

    get pending() {
      return count > 0
    },

    get count() {
      return count
    },

    dispose: () => {
      cancelTimers()
    },
  }
}