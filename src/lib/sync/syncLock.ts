/**
 * Cross-tab sync serialization.
 *
 * Two tabs of the same origin share IndexedDB. Without a common gate they can
 * plan a cycle from the same pending batch, push the same rows twice, and
 * subtract the same count twice. Web Locks gives every tab one exclusive gate;
 * the per-tab single-flight in the store still prevents overlapping cycles
 * inside one tab.
 *
 * `navigator.locks` is not available in every environment (older browsers,
 * server-side rendering, Node tests). In that case the run executes directly:
 * two tabs on such a browser are **not** serialized. That limitation is
 * accepted — silently emulating a lock in memory would not cross tabs at all.
 */
export const SYNC_LOCK_NAME = 'lexi-sync'

function defaultLockManager(): LockManager | undefined {
  return (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks
}

export async function withSyncLock<T>(
  run: () => Promise<T>,
  locks: LockManager | null | undefined = defaultLockManager(),
): Promise<T> {
  if (!locks || typeof locks.request !== 'function') return run()

  // The callback form releases the lock as soon as `run` settles, including on
  // rejection — so a failed cycle never blocks the next tab forever.
  return locks.request(SYNC_LOCK_NAME, { mode: 'exclusive' }, () => run()) as Promise<T>
}
