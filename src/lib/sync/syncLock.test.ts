import { describe, expect, it } from 'vitest'

import { withSyncLock } from './syncLock'

/**
 * A tiny Web Locks stand-in with the one behaviour the app depends on: requests
 * for the same lock run one at a time, in call order.
 */
function createFakeLocks() {
  const calls: Array<{ name: string; mode: LockMode }> = []
  let tail: Promise<unknown> = Promise.resolve()

  const locks = {
    request<T>(
      name: string,
      options: { mode?: LockMode },
      callback: () => Promise<T>,
    ): Promise<T> {
      calls.push({ name, mode: options.mode ?? 'exclusive' })
      const result = tail.then(callback)
      // A rejected run must still release the lock for the next request.
      tail = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
  }

  return { locks: locks as unknown as LockManager, calls }
}

describe('withSyncLock', () => {
  it('serializes two sync runs through the Web Lock', async () => {
    const order: string[] = []
    let release!: () => void
    const { locks } = createFakeLocks()

    const first = withSyncLock(async () => {
      order.push('first:start')
      await new Promise<void>((resolve) => {
        release = resolve
      })
      order.push('first:end')
    }, locks)
    const second = withSyncLock(async () => {
      order.push('second')
    }, locks)

    await Promise.resolve()
    expect(order).toEqual(['first:start'])

    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })

  it('requests the shared exclusive lock by name', async () => {
    const { locks, calls } = createFakeLocks()

    await withSyncLock(async () => 'done', locks)

    expect(calls).toEqual([{ name: 'lexi-sync', mode: 'exclusive' }])
  })

  it('releases the lock when the run rejects', async () => {
    const { locks } = createFakeLocks()

    await expect(
      withSyncLock(async () => {
        throw new Error('boom')
      }, locks),
    ).rejects.toThrow('boom')

    await expect(withSyncLock(async () => 'next', locks)).resolves.toBe('next')
  })

  it('runs directly when Web Locks are unavailable', async () => {
    const previous = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks
    delete (globalThis.navigator as { locks?: LockManager }).locks

    try {
      await expect(withSyncLock(async () => 'direct')).resolves.toBe('direct')
    } finally {
      if (previous !== undefined) {
        Object.defineProperty(globalThis.navigator, 'locks', {
          configurable: true,
          value: previous,
        })
      }
    }
  })
})
