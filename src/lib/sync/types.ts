import type { Document, Folder } from '../../types'
import type { StoreName } from '../storage/localDb'
import type { DocumentTombstone } from '../storage/purged'
import type { WordStateRecord } from './merge'
import type { OccurrenceRow } from './mapping'
import type { WriteLocalResult } from './writeLocal'

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

/** A table the push step sends; `languages` is a small union upsert. */
export type PushTable =
  | 'documents'
  | 'folders'
  | 'wordStates'
  | 'tombstones'
  | 'languages'
  | 'occurrences'

/** One rejected row, chunk, table, or pull. */
export type SyncFailure = {
  table: PushTable | 'pull'
  key?: string
  message: string
}

/**
 * What one push attempt did.
 *
 * `succeeded` names tables that fully went through; `succeededStores` maps those
 * to the local pending stores so callers subtract exactly what was sent.
 * `succeededKeys` are the dirty journal entries whose rows were pushed; callers
 * clear only when the revision still matches.
 */
export type PushResult = {
  failures: SyncFailure[]
  succeeded: ReadonlySet<PushTable>
  succeededStores: ReadonlySet<StoreName>
  succeededKeys: DirtyKey[]
  pushedRows: number
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

/** One cycle's result — what was pushed, pulled, merged, or rejected. */
export type SyncReport = {
  pushed: number
  pulled: number
  documents: number
  languages: string[]
  /** The next pull watermark. */
  watermarks: PullWatermarks
  /** The next per-table push watermarks; failed tables keep their old value. */
  pushWatermarks: PushWatermarks
  /**
   * **서버에 지금 있는** 단어 상태와 문서 수.
   *
   * 기기마다 진도가 다를 때 이 숫자가 가감을 알려 준다. 0 이면 이 기기의 변경이
   * 서버에 가지 않은 것이고, 0 이 아니면서 이 기기에 없는 것이면 **화면에만 안 보이는**
   * 것이다 — 방향이 완전히 다르다.
   */
  serverWords: number
  serverDocuments: number
  /** 이 기기에 지금 있는 단어 상태 수 */
  localWords: number
  /**
   * 서버와 달라져서 **등장 기록을 다시 보내야 하는** 문서.
   *
   * 비어 있으면 아무것도 보내지 않는다.
   */
  occurrencePush: string[]
  /** Rows, tables, or the pull that failed this cycle. */
  failures: SyncFailure[]
  /**
   * What this cycle actually wrote locally — unchanged rows are not counted.
   * `occurrences` counts documents whose occurrence rows were replaced.
   */
  localWrites: WriteLocalResult
  /** Stores whose entire pending batch was pushed (used to subtract pending counts). */
  succeededStores: StoreName[]
  /** Exact dirty keys pushed; clear only if the revision still matches. */
  succeededKeys: DirtyKey[]
}
