import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  getStorageEstimate,
  isStoragePersisted,
  isStorageSupported,
  requestPersistentStorage,
} from './storagePersistence'

/**
 * Storage status differs by browser, and some browsers have none at all.
 *
 * Calling an unsupported API throws and can take down the whole settings screen.
 * The contract here is one thing: **when in doubt, quietly answer "unknown."**
 * A missing Storage API must never block sync or any other setting.
 */

type NavigatorWithStorage = { storage?: unknown }

function installStorage(storage: unknown): () => void {
  const navigatorLike = globalThis.navigator as NavigatorWithStorage
  const had = Object.prototype.hasOwnProperty.call(navigatorLike, 'storage')
  const previous = navigatorLike.storage

  Object.defineProperty(navigatorLike, 'storage', {
    configurable: true,
    writable: true,
    value: storage,
  })

  return () => {
    if (had) {
      Object.defineProperty(navigatorLike, 'storage', {
        configurable: true,
        writable: true,
        value: previous,
      })
    } else {
      delete navigatorLike.storage
    }
  }
}

describe('storage persistence helpers', () => {
  let restore: (() => void) | null = null

  afterEach(() => {
    restore?.()
    restore = null
    vi.restoreAllMocks()
  })

  it('reports the browser persistence flag and estimate', async () => {
    const persisted = vi.fn(async () => true)
    const estimate = vi.fn(async () => ({ usage: 1_048_576, quota: 10_485_760 }))
    restore = installStorage({ persisted, estimate })

    expect(isStorageSupported()).toBe(true)
    await expect(isStoragePersisted()).resolves.toBe(true)
    await expect(getStorageEstimate()).resolves.toEqual({ usage: 1_048_576, quota: 10_485_760 })
    expect(persisted).toHaveBeenCalledTimes(1)
    expect(estimate).toHaveBeenCalledTimes(1)
  })

  it('asks the browser to persist local data', async () => {
    const persist = vi.fn(async () => false)
    restore = installStorage({ persist })

    await expect(requestPersistentStorage()).resolves.toBe(false)
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('returns false and null when navigator.storage is missing', async () => {
    restore = installStorage(undefined)

    expect(isStorageSupported()).toBe(false)
    await expect(isStoragePersisted()).resolves.toBe(false)
    await expect(requestPersistentStorage()).resolves.toBe(false)
    await expect(getStorageEstimate()).resolves.toBeNull()
  })

  it('returns false and null when the browser exposes only part of the API', async () => {
    // Safari has historically shipped StorageManager without persist().
    restore = installStorage({ persisted: async () => true })

    await expect(isStoragePersisted()).resolves.toBe(true)
    await expect(requestPersistentStorage()).resolves.toBe(false)
    await expect(getStorageEstimate()).resolves.toBeNull()
  })

  it('swallows rejections instead of failing the settings screen', async () => {
    restore = installStorage({
      persisted: async () => {
        throw new Error('denied')
      },
      persist: async () => {
        throw new Error('denied')
      },
      estimate: async () => {
        throw new Error('denied')
      },
    })

    await expect(isStoragePersisted()).resolves.toBe(false)
    await expect(requestPersistentStorage()).resolves.toBe(false)
    await expect(getStorageEstimate()).resolves.toBeNull()
  })

  it('treats an incomplete estimate as unavailable', async () => {
    restore = installStorage({ estimate: async () => ({ usage: 1024 }) })

    await expect(getStorageEstimate()).resolves.toBeNull()
  })
})
