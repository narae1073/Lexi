import type { Document, Folder } from '../../types'
import type { StoreName } from '../storage/localDb'
import type { DocumentTombstone } from '../storage/purged'
import type { WordStateRecord } from './merge'
import type { OccurrenceRow } from './mapping'
import type { ProjectionState } from './projectionState'
import type { ProjectionQuotaBucket, ProjectionRow } from './wordbookPull'
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
 * A safe-degradation notice for the cycle. `clock-rollback` means the device
 * clock moved behind a stored push watermark, so every push watermark was
 * cleared and the local rows were re-pushed by timestamp/dirty key.
 */
export type SyncWarning = 'clock-rollback'

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

/**
 * What one cycle's projection pull read.
 *
 * The projection has its own snapshot and per-language cursor; it never shares
 * the document pull watermark. `next` is applied to the reserved device-local
 * state **after** the rows it describes are stored (see `syncOnce`), which is
 * what makes a crash resume from a cursor that still names stored rows.
 */
export type ProjectionPull = {
  /** Languages whose projection was requested this cycle. */
  languages: string[]
  /** Languages pulled from a new full snapshot this cycle (empty on resume). */
  full: string[]
  /**
   * Languages that start a **fresh** full pass this cycle: their stored state
   * had no usable snapshot (new language, corrupted state, or a manual reset).
   * Only these are cleared before their rows are applied; a resumed full pass
   * must never clear what its earlier pages already stored.
   */
  reset: string[]
  /** Per-language state to persist after the rows are stored. */
  next: Record<string, ProjectionState>
  /** Per-language completeness after this cycle. */
  complete: Partial<Record<string, boolean>>
  /**
   * Full or incremental passes that could not finish this cycle. Rows read so
   * far and their cursors are stored; the next cycle resumes. `pauseReason`
   * says whether the soft byte budget or a server quota caused the pause.
   */
  paused: string[]
  /** Why {@link paused} is non-empty, or null when every pass finished. */
  pauseReason: 'bytes' | 'quota' | 'state' | null
  /** Denied quota bucket and backoff when `pauseReason` is `quota`. */
  quota: { bucket: ProjectionQuotaBucket; retryAfterSeconds: number } | null
  /** Server snapshot this cycle's projection passes were bounded by. */
  snapshot: string
}

export type PullResult = {
  languages: string[]
  documents: Document[]
  tombstones: DocumentTombstone[]
  folders: Folder[]
  wordStates: WordStateRecord[]
  occurrences: OccurrenceRow[]
  /**
   * Document ids whose occurrence rows were read in full this cycle. An empty
   * list means the initial projection path read no occurrences: the merge must
   * keep the local rows instead of treating them as removed.
   */
  occurrenceDocumentIds: string[]
  /** Wordbook projection rows read this cycle, possibly spanning languages. */
  wordbookEntries: ProjectionRow[]
  projection: ProjectionPull
  totals: { documents: number; wordStates: number }
  watermarks: { snapshot: string }
}

/** One cycle's result — what was pushed, pulled, merged, or rejected. */
export type SyncReport = {
  pushed: number
  pulled: number
  documents: number
  languages: string[]
  /** Languages whose wordbook projection was requested this cycle. */
  projectionLanguages: string[]
  /**
   * Base wordbook completeness per language: true once a full pass finished,
   * so the language is offline-complete at its stored snapshot. This is **not**
   * "this cycle's pass finished" — `projectionPaused` carries the per-cycle
   * pass state. Task 10 must treat `projectionPaused` as the progress signal
   * and must not infer an unfinished pass from `projectionComplete`.
   */
  projectionComplete: Partial<Record<string, boolean>>
  /**
   * Full projection passes paused by the soft 64 MB byte budget or by a server
   * quota denial. Their cursor is stored, so the next cycle resumes them; the
   * UI can show a continue prompt instead of an error (Task 10 owns the prompt
   * copy). Fresh full passes resume from a cursor and do not spend the daily
   * complete-sync quota again.
   */
  projectionPaused: string[]
  /** Why `projectionPaused` is non-empty; null when nothing was paused. */
  projectionPausedReason: 'bytes' | 'quota' | 'state' | null
  /** Denied quota bucket when the pause was a rate/daily limit. */
  projectionQuotaBucket: ProjectionQuotaBucket | null
  /** Seconds the client should wait before the next projection retry. */
  projectionQuotaRetryAfterSeconds: number | null
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
   * Non-fatal conditions the user should know about. A clock rollback clears
   * every push watermark; the stored pull watermark is never cleared.
   */
  warnings: SyncWarning[]
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

/**
 * Messages between tabs of the same origin.
 *
 * `local-write` carries the reserved sync-meta record as read after the write
 * transaction committed, so a receiving tab can adopt the shared pending
 * counts without a second IndexedDB read. `synced` carries the completed
 * report; the receiving tab updates its status and then re-reads pending from
 * the shared record (the message is not the source of truth for counts).
 */
export type SyncMessage =
  | { type: 'local-write'; meta: LocalSyncMeta }
  | { type: 'synced'; userId: string; report: SyncReport }

