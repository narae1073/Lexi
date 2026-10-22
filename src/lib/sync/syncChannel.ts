import type { SyncMessage } from './types'

/**
 * Tab-to-tab sync notifications.
 *
 * The reserved sync-meta record in IndexedDB is the source of truth for
 * pending counts. The channel only tells other tabs that the record changed so
 * they can refresh without polling (and, after a completed cycle, that their
 * status/report is stale).
 *
 * `BroadcastChannel` is a browser API. Environments without it (SSR, Node
 * tests) get a no-op channel: state stays correct because it still comes from
 * IndexedDB, but a tab will not learn about another tab's write until its next
 * read. Two-tab convergence therefore requires BroadcastChannel.
 */
export const SYNC_CHANNEL_NAME = 'lexi-sync'

export type SyncChannel = {
  post(message: SyncMessage): void
  subscribe(listener: (message: SyncMessage) => void): () => void
  close(): void
}

type BroadcastChannelConstructor = new (name: string) => BroadcastChannel

function defaultConstructor(): BroadcastChannelConstructor | null {
  if (typeof window === 'undefined') return null
  return (
    (globalThis as { BroadcastChannel?: BroadcastChannelConstructor }).BroadcastChannel ?? null
  )
}

const NOOP: SyncChannel = {
  post() {},
  subscribe() {
    return () => {}
  },
  close() {},
}

export function createSyncChannel(
  scope = SYNC_CHANNEL_NAME,
  Constructor: BroadcastChannelConstructor | null = defaultConstructor(),
): SyncChannel {
  if (Constructor === null) return NOOP

  const channel = new Constructor(scope)
  const listeners = new Set<(message: SyncMessage) => void>()
  let closed = false

  channel.onmessage = (event: MessageEvent<SyncMessage>) => {
    for (const listener of listeners) {
      try {
        listener(event.data)
      } catch (error) {
        // One bad listener must not stop the others from converging.
        console.error('동기화 메시지 처리 실패', error)
      }
    }
  }

  return {
    post(message) {
      if (closed) return
      try {
        channel.postMessage(message)
      } catch (error) {
        // A closed/terminated channel is not a sync failure: IndexedDB still
        // holds the authoritative record the next write/read will use.
        console.error('동기화 메시지 전송 실패', error)
      }
    },
    subscribe(listener) {
      if (closed) return () => {}
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    close() {
      if (closed) return
      closed = true
      listeners.clear()
      channel.onmessage = null
      channel.close()
    },
  }
}
