import { describe, expect, it, vi } from 'vitest'

import { createSyncChannel } from './syncChannel'
import type { LocalSyncMeta, SyncMessage, SyncReport } from './types'

type Listener = (event: MessageEvent<SyncMessage>) => void

/** In-memory BroadcastChannel bus, split by channel name like the real API. */
class FakeBroadcastChannel {
  static buses = new Map<string, Set<FakeBroadcastChannel>>()

  onmessage: Listener | null = null
  readonly name: string
  closed = false

  constructor(name: string) {
    this.name = name
    const bus = FakeBroadcastChannel.buses.get(name) ?? new Set()
    bus.add(this)
    FakeBroadcastChannel.buses.set(name, bus)
  }

  postMessage(message: SyncMessage) {
    const bus = FakeBroadcastChannel.buses.get(this.name) ?? new Set()
    for (const other of bus) {
      if (other === this || other.closed) continue
      other.onmessage?.({ data: structuredClone(message) } as MessageEvent<SyncMessage>)
    }
  }

  close() {
    this.closed = true
    FakeBroadcastChannel.buses.get(this.name)?.delete(this)
  }
}

function resetBus() {
  FakeBroadcastChannel.buses.clear()
}

const meta: LocalSyncMeta = {
  documentId: '__lexi_sync_meta__',
  epoch: 'epoch-a',
  revision: 3,
  pendingByStore: { documents: 2, wordStates: 1 },
  dirty: {},
}

const report: SyncReport = {
  pushed: 0,
  pulled: 0,
  documents: 0,
  languages: [],
  projectionLanguages: [],
  projectionComplete: {},
  projectionPaused: [],
  projectionPausedReason: null,
  projectionQuotaBucket: null,
  projectionQuotaRetryAfterSeconds: null,
  watermarks: {},
  pushWatermarks: {},
  serverWords: 0,
  serverDocuments: 0,
  localWords: 0,
  occurrencePush: [],
  failures: [],
  warnings: [],
  localWrites: {
    documents: 0,
    folders: 0,
    wordStates: 0,
    tombstones: 0,
    occurrences: 0,
  },
  succeededStores: [],
  succeededKeys: [],
}

const FakeCtor = FakeBroadcastChannel as unknown as typeof BroadcastChannel

describe('SyncChannel', () => {
  it('broadcasts a local-write meta and a synced report', () => {
    resetBus()
    const sender = createSyncChannel('lexi-sync', FakeCtor)
    const receiver = createSyncChannel('lexi-sync', FakeCtor)
    const received: SyncMessage[] = []
    receiver.subscribe((message) => received.push(message))

    sender.post({ type: 'local-write', meta })
    sender.post({ type: 'synced', userId: 'user-a', report })

    expect(received).toEqual([
      { type: 'local-write', meta },
      { type: 'synced', userId: 'user-a', report },
    ])

    sender.close()
    receiver.close()
  })

  it('delivers only to other channels on the same scope', () => {
    resetBus()
    const sender = createSyncChannel('lexi-sync', FakeCtor)
    const sameScope = createSyncChannel('lexi-sync', FakeCtor)
    const otherScope = createSyncChannel('other-sync', FakeCtor)
    const same = vi.fn()
    const other = vi.fn()
    sameScope.subscribe(same)
    otherScope.subscribe(other)

    sender.post({ type: 'local-write', meta })

    expect(same).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()

    sender.close()
    sameScope.close()
    otherScope.close()
  })

  it('stops delivering after unsubscribe and close', () => {
    resetBus()
    const sender = createSyncChannel('lexi-sync', FakeCtor)
    const receiver = createSyncChannel('lexi-sync', FakeCtor)
    const listener = vi.fn()
    const unsubscribe = receiver.subscribe(listener)

    sender.post({ type: 'local-write', meta })
    unsubscribe()
    sender.post({ type: 'local-write', meta })
    receiver.close()
    sender.post({ type: 'local-write', meta })

    expect(listener).toHaveBeenCalledTimes(1)

    sender.close()
  })

  it('is a no-op when BroadcastChannel is absent', () => {
    const channel = createSyncChannel('lexi-sync', null)
    const listener = vi.fn()

    expect(() => channel.post({ type: 'local-write', meta })).not.toThrow()
    const unsubscribe = channel.subscribe(listener)
    expect(() => unsubscribe()).not.toThrow()
    expect(() => channel.close()).not.toThrow()
    expect(listener).not.toHaveBeenCalled()
  })
})
