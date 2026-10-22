/**
 * Storage persistence and usage, feature-detected.
 *
 * The browser may clear IndexedDB when disk pressure rises. Asking for
 * persistence reduces that risk; the estimate tells the user how much room the
 * app takes. None of this is guaranteed — Safari and some headless/first-party
 * contexts expose only part of the Storage API, and querying it can reject.
 *
 * Every helper therefore answers honestly instead of throwing: an unknown or
 * unsupported state must never break the settings screen or block sync.
 */

type StorageManagerLike = {
  persisted?: () => Promise<boolean>
  persist?: () => Promise<boolean>
  estimate?: () => Promise<{ usage?: number; quota?: number }>
}

function storageManager(): StorageManagerLike | null {
  try {
    const navigatorLike = (globalThis as { navigator?: { storage?: StorageManagerLike } }).navigator
    const storage = navigatorLike?.storage
    return storage ?? null
  } catch {
    return null
  }
}

/** Whether this browser exposes the Storage API at all. */
export function isStorageSupported(): boolean {
  return storageManager() !== null
}

/**
 * Whether the browser currently promises not to evict this origin's data.
 *
 * Unsupported or failing queries read as `false` — "not confirmed" is the
 * honest answer, and the UI tells the user the browser may clear data.
 */
export async function isStoragePersisted(): Promise<boolean> {
  try {
    const storage = storageManager()
    if (typeof storage?.persisted !== 'function') return false
    return (await storage.persisted()) === true
  } catch {
    return false
  }
}

/**
 * Asks the browser to keep this origin's data. Must be called from a user
 * gesture in most browsers; a denial is a valid answer, not an error.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const storage = storageManager()
    if (typeof storage?.persist !== 'function') return false
    return (await storage.persist()) === true
  } catch {
    return false
  }
}

/**
 * Usage and quota in bytes, or `null` when the browser cannot tell.
 *
 * A partial estimate (one number missing) is treated as unavailable rather
 * than shown as a misleading zero.
 */
export async function getStorageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const storage = storageManager()
    if (typeof storage?.estimate !== 'function') return null
    const estimate = await storage.estimate()
    if (
      typeof estimate?.usage !== 'number' ||
      !Number.isFinite(estimate.usage) ||
      typeof estimate.quota !== 'number' ||
      !Number.isFinite(estimate.quota)
    ) {
      return null
    }
    return { usage: estimate.usage, quota: estimate.quota }
  } catch {
    return null
  }
}
