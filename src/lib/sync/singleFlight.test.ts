import { describe, expect, it } from 'vitest'

import { createSingleFlight } from './singleFlight'

describe('한 번에 하나만', () => {
  it('동시에 두 번 불러도 한 번만 돌고, 끝난 뒤 한 번 더 돈다', async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const run = createSingleFlight(async () => {
      calls += 1
      await gate
    })

    const first = run()
    const second = run()
    await Promise.resolve()
    expect(calls).toBe(1)

    release()
    await first
    await second
    // 끝난 뒤 rerun 이 예약된다 — 그 사이에 바뀐 것을 놓치지 않는다
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toBe(2)
  })

  it('한 번만 부르면 한 번만 돈다', async () => {
    let calls = 0
    const run = createSingleFlight(async () => {
      calls += 1
    })
    await run()
    expect(calls).toBe(1)
  })

  it('실행 중인 한 번의 run 이 끝나야 whenIdle 이 resolve 된다', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const run = createSingleFlight(async () => {
      await gate
    })

    const running = run()
    let idle = false
    const waiting = run.whenIdle().then(() => {
      idle = true
    })

    await Promise.resolve()
    expect(idle).toBe(false)

    release()
    await Promise.all([running, waiting])
    expect(idle).toBe(true)
  })

  it('queued rerun 이 끝난 뒤에야 whenIdle 이 resolve 된다', async () => {
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    let secondStarted!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const started = new Promise<void>((resolve) => {
      secondStarted = resolve
    })
    let calls = 0
    const run = createSingleFlight(async () => {
      calls += 1
      if (calls === 1) await firstGate
      else {
        secondStarted()
        await secondGate
      }
    })

    const first = run()
    run()
    let idle = false
    const waiting = run.whenIdle().then(() => {
      idle = true
    })

    releaseFirst()
    await started
    expect(calls).toBe(2)
    expect(idle).toBe(false)

    releaseSecond()
    await Promise.all([first, waiting])
    expect(idle).toBe(true)
  })
})
