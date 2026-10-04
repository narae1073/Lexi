import { describe, expect, it, vi } from 'vitest'

import { createSyncScheduler } from './syncScheduler'

/**
 * 미뤄 두었다가 보내는 policies.
 *
 * 진도를 잃어버린 일의 상당 부분은 여기서 결정된다 — 아무도 안 보내면 그대로
 * 사라진다. 테스트는 가짜 시계로 한다.
 */
describe('저장后排기', () => {
  it('바꾸면 곧바로 보낸다 — 기다리는 동안이 잃는 시간이다', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const scheduler = createSyncScheduler({ flush, debounceMs: 1000, maxWaitMs: 10_000 })

    scheduler.notify()
    expect(flush).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('연속으로 여러 번 바꿔도 한 번만 보낸다', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const scheduler = createSyncScheduler({ flush, debounceMs: 1000, maxWaitMs: 10_000 })

    for (let i = 0; i < 20; i++) {
      scheduler.notify()
      vi.advanceTimersByTime(100)
    }
    expect(flush).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  /**
   * 계속 두드리는 사람에게는 한 번쯤은 보내야 한다.
   *
   * 미루기만 하다가 창을 닫으면 서버에 아무것도 못 올라간다 — 이게 원인이었다.
   */
  it('계속 바꿔도 최대 대기 시간을 넘으면 보낸다', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const scheduler = createSyncScheduler({ flush, debounceMs: 1000, maxWaitMs: 5000 })

    for (let i = 0; i < 40; i++) {
      scheduler.notify()
      vi.advanceTimersByTime(400)
    }
    expect(flush).toHaveBeenCalled()
  })

  it('보내는 중이면 쌓아 둔다 — 그 사이의 변경을 놓치지 않는다', async () => {
    vi.useFakeTimers()
    let release: (() => void) | undefined
    const flush = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const scheduler = createSyncScheduler({ flush, debounceMs: 1000, maxWaitMs: 10_000 })

    scheduler.notify()
    await vi.advanceTimersByTimeAsync(1000)
    expect(flush).toHaveBeenCalledTimes(1)

    // 첫 번째가 아직 끝나지 않았는데 또 바꿨다
    scheduler.notify()
    await vi.advanceTimersByTimeAsync(1000)
    expect(flush).toHaveBeenCalledTimes(1)

    release?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(flush).toHaveBeenCalledTimes(2)
  })

  /**
   * 창을 닫을 때는 미룬 시간을 기다리지 않는다.
   *
   * 1.2초를 기다리다 닫으면 아무것도 안 나간다.
   */
  it('지금 보내라고 하면 미뤄 둔 시간을 기다리지 않는다', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const scheduler = createSyncScheduler({ flush, debounceMs: 1000, maxWaitMs: 10_000 })

    scheduler.notify()
    scheduler.flushNow()
    expect(flush).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5000)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('바뀐 것이 없으면 지금 보내도 하지 않는다', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const scheduler = createSyncScheduler({ flush, debounceMs: 1000, maxWaitMs: 10_000 })

    scheduler.flushNow()
    expect(flush).not.toHaveBeenCalled()
  })

  it('보낸 뒤에는 다시 보낼 것이 없다 — 이 판단을 해야 창을 닫을 때 헛손댈 일이 없다', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const scheduler = createSyncScheduler({ flush, debounceMs: 1000, maxWaitMs: 10_000 })

    scheduler.notify()
    scheduler.flushNow()
    expect(scheduler.pending).toBe(false)

    scheduler.flushNow()
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('보낸 뒤에도 변경이 계속되면 다시 보낸다', async () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const scheduler = createSyncScheduler({ flush, debounceMs: 1000, maxWaitMs: 10_000 })

    scheduler.notify()
    scheduler.flushNow()
    expect(scheduler.pending).toBe(false)

    scheduler.notify()
    await vi.advanceTimersByTimeAsync(1000)
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('여러 번 바뀌면 횟수를 기억한다 — 얼마나 밀렸는지 말할 수 있어야 한다', () => {
    vi.useFakeTimers()
    const scheduler = createSyncScheduler({ flush: vi.fn(), debounceMs: 1000, maxWaitMs: 10_000 })

    scheduler.notify()
    scheduler.notify()
    scheduler.notify()
    expect(scheduler.count).toBe(3)

    scheduler.flushNow()
    expect(scheduler.count).toBe(0)
  })

  it('정리하면 남은 예약이 없다 — 창을 닫았는데 타이머가 살아 있으면 안 된다', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const scheduler = createSyncScheduler({ flush, debounceMs: 1000, maxWaitMs: 10_000 })

    scheduler.notify()
    scheduler.dispose()
    vi.advanceTimersByTime(20_000)
    expect(flush).not.toHaveBeenCalled()
  })
})