import type { Document, Folder } from '../../types'
import type { StoreName } from '../storage/localDb'
import type { DocumentTombstone } from '../storage/purged'
import type { WordStateRecord } from './merge'
import type { OccurrenceRow } from './mapping'

export type PullWatermarks = { snapshot?: string }

/**
 * Reserved record stored in the local-only `documentMeta` store under
 * `SYNC_META_KEY`. It owns the local bookkeeping Release 2 sync depends on:
 * a monotonic user-write revision, per-store pending counts, a per-key dirty
 * journal, and the epoch of this local database.
 */
export type LocalSyncMeta = {
  documentId: '__lexi_sync_meta__'
  /** Random UUID created with the IndexedDB; changed when the DB is deleted/recreated. */
  epoch: string
  /** Monotonic local user-write counter. Silent sync writes never bump this. */
  revision: number
  /** Number of user writes not yet confirmed pushed, by synced store. */
  pendingByStore: Partial<Record<StoreName, number>>
  /** Per-key local writes not yet confirmed pushed; revision is the last local write. */
  dirty: Partial<Record<StoreName, Record<string, number>>>
}

/** One dirty journal entry: a key in a synced store at its last local write revision. */
export type DirtyKey = { store: StoreName; key: string; revision: number }

/** Client-time push watermarks, one per pushed table. */
export type PushWatermarks = {
  documents?: string
  folders?: string
  wordStates?: string
  tombstones?: string
  occurrences?: string
}

/**
 * Sync state persisted per user. Version 1 (a single `pushedAt`) reads as
 * absent so upgrading does one full pull and full push.
 */
export type StoredSyncState = {
  version: 2
  pull: PullWatermarks
  push: PushWatermarks
  localEpoch: string
  lastSyncedAt?: string
}

export type PullResult = {
  languages: string[]
  documents: Document[]
  tombstones: DocumentTombstone[]
  folders: Folder[]
  wordStates: WordStateRecord[]
  occurrences: OccurrenceRow[]
  totals: { documents: number; wordStates: number }
  watermarks: { snapshot: string }
}
