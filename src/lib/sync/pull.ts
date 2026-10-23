import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '../supabase/database.types'
import {
  DOCUMENT_METADATA_COLUMNS,
  documentMetadataFromRow,
  documentTombstoneFromRow,
  folderFromRow,
  wordStateFromRow,
} from './mapping'
import type {
  DocumentMetadataRow,
  DocumentTombstoneRow,
  FolderRow,
  OccurrenceRow,
  WordStateRow,
} from './mapping'
import {
  emptyProjectionState,
  projectionStateFor,
  readProjectionState,
  updateProjectionState,
  type ProjectionState,
  type ProjectionStateMap,
} from './projectionState'
import {
  PROJECTION_PAGE_MAX,
  ProjectionPassError,
  ProjectionQuotaError,
  projectionPageLimit,
  pullProjectionPageBounded,
  recordProjectionQuotaDenial,
} from './wordbookPull'
import type { ProjectionQuotaBucket, ProjectionRow } from './wordbookPull'
import type { PullResult, ProjectionPull, PullWatermarks } from './types'

export const SNAPSHOT_OVERLAP_MS = 5 * 60_000

/**
 * Soft cap for one cycle's wordbook projection download.
 *
 * A projection larger than this is not an error: the rows read so far are
 * stored with their cursor, the language is reported as paused, and the next
 * cycle resumes. The cap only bounds one cycle's memory and time.
 */
export const PROJECTION_BYTE_BUDGET = 64 * 1024 * 1024

/**
 * Soft cap for one document's content/occurrence payload (Task 9).
 *
 * Re-exported here because the pull protocol owns the byte budgets; the lazy
 * content path in `content.ts` enforces it. A document above the cap is read
 * page by page instead of in one response.
 */
export { DOCUMENT_PAYLOAD_BYTE_BUDGET } from './content'

const PAGE_SIZE = 1000

type SyncTable =
  | 'user_languages'
  | 'documents'
  | 'document_tombstones'
  | 'folders'
  | 'word_states'
  | 'word_occurrences'

export async function fetchAll<T>(
  db: SupabaseClient<Database>,
  table: SyncTable,
  userId: string,
  order: string,
  columns = '*',
  options: {
    since?: string
    until?: string
    sinceColumn?: string
    documentIds?: readonly string[]
  } = {},
): Promise<T[]> {
  type PageResult = { data: unknown[] | null; error: { message: string } | null }
  type Ordered = {
    limit: (count: number) => PromiseLike<PageResult>
    gt: (column: string, value: string | number) => {
      limit: (count: number) => PromiseLike<PageResult>
    }
  }
  type Filterable = {
    in: (column: string, values: readonly string[]) => Filterable
    gte: (column: string, value: string) => Filterable
    lte: (column: string, value: string) => Filterable
    order: (column: string, opts: { ascending: boolean }) => Ordered
  }

  const rows: T[] = []
  let last: string | number | undefined

  while (true) {
    let filterable = (db as never as {
      from: (table: string) => {
        select: (columns: string) => {
          eq: (column: string, value: string) => Filterable
        }
      }
    })
      .from(table)
      .select(columns)
      .eq('user_id', userId)

    if (options.documentIds && options.documentIds.length > 0) {
      filterable = filterable.in('document_id', options.documentIds)
    }
    if (options.since !== undefined && options.sinceColumn !== undefined) {
      filterable = filterable.gte(options.sinceColumn, options.since)
    }
    if (options.until !== undefined && options.sinceColumn !== undefined) {
      filterable = filterable.lte(options.sinceColumn, options.until)
    }

    const ordered = filterable.order(order, { ascending: true })
    const result =
      last === undefined
        ? await ordered.limit(PAGE_SIZE)
        : await ordered.gt(order, last).limit(PAGE_SIZE)

    const { data, error } = result
    if (error) throw error

    const page = (data ?? []) as T[]
    rows.push(...page)
    if (page.length < PAGE_SIZE) break

    const lastRow = page[page.length - 1] as Record<string, unknown>
    const next = lastRow[order]
    if (typeof next !== 'string' && typeof next !== 'number') {
      throw new Error(`${table} 의 ${order} 값이 없어 다음 페이지를 읽을 수 없습니다`)
    }
    last = next
  }
  return rows
}

export async function countRows(
  db: SupabaseClient<Database>,
  table: 'documents' | 'word_states',
  userId: string,
  until?: string,
): Promise<number> {
  type CountResult = { count: number | null; error: { message: string } | null }
  type CountQuery = PromiseLike<CountResult> & {
    eq: (column: string, value: string) => CountQuery
    lte: (column: string, value: string) => CountQuery
  }
  const query = (db as never as {
    from: (table: string) => {
      select: (
        columns: string,
        options: { count: 'exact'; head: true },
      ) => CountQuery
    }
  })
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
  // Count requests are bounded by the same snapshot as their corresponding row reads.
  const result = await (until === undefined ? query : query.lte('server_updated_at', until))
  if (result.error) throw result.error
  return result.count ?? 0
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

/** Approximate serialized size of one projection row, for the soft budget. */
export function projectionRowBytes(row: ProjectionRow): number {
  const json = JSON.stringify(row)
  if (typeof Blob !== 'undefined') return new Blob([json]).size
  return json.length * 2
}

export type PullOptions = {
  /**
   * Languages this device enrolled. Server languages are unioned in, so a new
   * device that has not adopted its language list yet still downloads the
   * projection in the first cycle.
   */
  languages?: readonly string[]
  /** Pre-read projection state; `pull` reads it itself when omitted. */
  projectionState?: ProjectionStateMap
  /** Force a fresh full projection (manual resync). */
  resetProjection?: boolean
  /** Override the soft projection byte budget (tests only). */
  projectionByteBudget?: number
}

type ProjectionPass = {
  language: string
  full: boolean
  /** A fresh full pass: the language must be cleared before its rows apply. */
  fresh: boolean
  /**
   * Snapshot for a full pass, or the overlap-adjusted incremental watermark
   * (`prior snapshot - SNAPSHOT_OVERLAP_MS`) for a complete one.
   */
  bound: string
  /** Resume point inside this pass; null starts at the first lemma. */
  cursor: string | null
  previous: ProjectionState
  done: boolean
  /** Rows read so far; 0 means no page of this pass has been read yet. */
  received: number
  /** The server rejected this pass's cursor state; start over next cycle. */
  restart: boolean
  /**
   * Snapshot the restarted pass must reuse. Null means the server rejected a
   * completed pass, so only a new snapshot can make progress.
   */
  restartSnapshot: string | null
}

/**
 * Incremental reads start a few minutes before the stored completion
 * watermark. A transaction that commits after our snapshot but stamped a row
 * slightly earlier (commit/clock skew) would otherwise be invisible forever,
 * because the next watermark is the snapshot itself.
 */
function incrementalSince(snapshot: string): string {
  return new Date(Date.parse(snapshot) - SNAPSHOT_OVERLAP_MS).toISOString()
}

/**
 * Reads the wordbook projection for every target language.
 *
 * Full passes are bounded by one snapshot and exclude soft deletions. Complete
 * languages use the bounded incremental form (`server_updated_at > watermark`),
 * which includes soft deletions so a removal propagates. Passes advance in
 * rounds — one page per language — so one huge language cannot starve the
 * others before the byte budget pauses the cycle.
 *
 * Resetting is a property of a pass, not of a cycle. A manual reset discards
 * the stored state only when there is no full pass already in progress; an
 * incomplete language with a snapshot resumes its cursor, and `reset` names
 * only passes that truly start from lemma 0 and therefore must be cleared.
 * That is what makes a paused manual reset converge instead of re-downloading
 * from the first lemma forever.
 *
 * Incremental passes are watermark-bounded and also obey the byte budget. They
 * always restart at the stored watermark (minus the overlap) rather than a
 * keyset cursor, because rows that changed *behind* a cursor while a pass was
 * paused would otherwise be skipped. Re-reading the overlap is idempotent, so
 * a paused incremental pass can make progress or resume safely.
 *
 * A server quota denial pauses every unfinished pass instead of failing the
 * cycle. Pages already read are returned and stored with their cursors; a
 * brand-new pass denied before its first page keeps its snapshot without being
 * marked for a clear, so the next cycle resumes the same pass (no new daily
 * charge) and clears the local wordbook only when it can actually download.
 *
 * The caller must store the rows before persisting `next`; advancing a cursor
 * over rows that were not written is the one way a correct page can lose data.
 */
async function pullProjection(
  db: SupabaseClient<Database>,
  userId: string,
  snapshot: string,
  languages: readonly string[],
  state: ProjectionStateMap,
  reset: boolean,
  budget: number,
): Promise<{ pull: ProjectionPull; rows: ProjectionRow[] }> {
  const targets = [...new Set(languages.filter((code) => typeof code === 'string' && code !== ''))]
  const rows: ProjectionRow[] = []
  const paused: string[] = []
  const fullLanguages: string[] = []
  const resetLanguages: string[] = []

  const passes: ProjectionPass[] = []
  for (const language of targets) {
    const stored = projectionStateFor(state, language)
    // A reset only starts a new pass. An incomplete language that already has
    // a snapshot is a reset (or ordinary full pull) in progress; restarting it
    // would download from lemma 0 again and re-clear the local wordbook.
    const wantReset =
      reset && !(stored.complete === false && stored.snapshot !== null)
    const previous = wantReset ? emptyProjectionState() : stored
    // A complete language pulls incrementally from its stored watermark. An
    // incomplete one resumes its full snapshot (or starts a new one).
    const full = !previous.complete || previous.snapshot === null
    // A full pass with no cursor has applied no row of its snapshot yet, so it
    // must still clear the language before applying. This covers a manual
    // reset, a new language, and a same-snapshot restart after an interrupted
    // first projection.
    const fresh = full && (previous.snapshot === null || previous.cursor === null)
    const bound = full
      ? (previous.snapshot ?? snapshot)
      : incrementalSince(previous.snapshot as string)
    if (full) fullLanguages.push(language)
    if (fresh) resetLanguages.push(language)
    passes.push({
      language,
      full,
      fresh,
      bound,
      // An incremental pass always starts at its watermark: a stored cursor
      // could be past rows that changed behind it while the pass was paused.
      cursor: full ? (previous.cursor?.lemma ?? null) : null,
      previous,
      done: false,
      received: 0,
      restart: false,
      restartSnapshot: null,
    })
  }

  /**
   * Persist a new full pass's snapshot *before* its first page.
   *
   * Without this, a failed second page leaves no local state even though the
   * server already charged the snapshot. The next attempt would take a new
   * snapshot and spend a second daily unit; two failures could strand the
   * device for the rest of the UTC day. The cursor stays null here: rows are
   * only applied later, and this marker is what lets the retry restart the
   * same snapshot (free) from the first lemma.
   */
  for (const pass of passes) {
    if (!pass.full || pass.previous.snapshot !== null) continue
    await updateProjectionState(userId, pass.language, (current) => ({
      complete: false,
      snapshot: pass.bound,
      cursor: null,
      hydratedAt: current.hydratedAt,
    }))
  }

  let bytes = 0
  let index = 0
  let pauseReason: 'bytes' | 'quota' | 'state' | null = null
  let quota: { bucket: ProjectionQuotaBucket; retryAfterSeconds: number } | null = null
  while (passes.some((pass) => !pass.done)) {
    const pass = passes[index % passes.length]
    index += 1
    if (pass.done) continue

    const limit = projectionPageLimit(PROJECTION_PAGE_MAX)
    let page: ProjectionRow[]
    let hasMore: boolean
    let nextCursor: string | null
    try {
      const result = pass.full
        ? await pullProjectionPageBounded(db, userId, pass.language, pass.bound, pass.cursor, limit)
        : await pullProjectionPageBounded(
            db,
            userId,
            pass.language,
            null,
            // The first page of an incremental pass starts at the watermark
            // (`pass.cursor` is null), ignoring any stored cursor so rows that
            // changed behind it are re-read. Later pages of the same pass advance
            // by keyset, otherwise a change set of >= one page would fetch the
            // same first page forever.
            pass.cursor,
            limit,
            pass.bound,
          )
      page = result.rows
      hasMore = result.hasMore
      nextCursor = result.nextCursor
    } catch (error) {
      if (error instanceof ProjectionPassError) {
        // The server cursor state and this device's state disagree. Reusing the
        // same snapshot from the first lemma is safe for an incomplete pass
        // (rows are re-applied idempotently) and does not spend another daily
        // unit. A completed pass cannot rewind, so only that reason needs a new
        // snapshot next cycle.
        pauseReason = 'state'
        pass.restart = true
        pass.restartSnapshot = error.reason === 'complete' ? null : pass.bound
        for (const pending of passes) {
          if (pending.done) continue
          paused.push(pending.language)
          if (pending.fresh && pending.received === 0) {
            // Nothing was read for this new pass. Keep its snapshot marker but
            // do not clear the local language for an empty download.
            const resetIndex = resetLanguages.indexOf(pending.language)
            if (resetIndex !== -1) resetLanguages.splice(resetIndex, 1)
          }
        }
        break
      }
      if (!(error instanceof ProjectionQuotaError)) throw error
      // A quota denial is a temporary pause, not a failed sync. Keep the rows
      // read so far; the loop below stores them and their cursors, and the next
      // cycle resumes. Record the 429 separately for the pre-public metrics
      // (the denied page's own counter was rolled back with its exception).
      quota = { bucket: error.bucket, retryAfterSeconds: error.retryAfterSeconds }
      pauseReason = 'quota'
      await recordProjectionQuotaDenial(db, error.bucket)
      for (const pending of passes) {
        if (pending.done) continue
        paused.push(pending.language)
        if (pending.fresh && pending.received === 0) {
          // Nothing was read for this new pass, so the local language must not
          // be cleared for an empty download. The snapshot marker remains, so
          // the next cycle resumes the same pass without a new daily charge.
          const resetIndex = resetLanguages.indexOf(pending.language)
          if (resetIndex !== -1) resetLanguages.splice(resetIndex, 1)
        }
      }
      break
    }

    const pageBytes = page.reduce((sum, row) => sum + projectionRowBytes(row), 0)
    rows.push(...page)
    pass.received += page.length
    // Incremental pages count too: a huge change set must not ignore the soft
    // cap just because the language was already complete.
    bytes += pageBytes

    // `hasMore` is authoritative, not `page.length < limit`: a byte-bounded
    // page can be short while the language continues.
    if (!hasMore) {
      pass.done = true
    } else {
      pass.cursor = nextCursor
    }

    if (bytes >= budget && passes.some((pending) => !pending.done)) {
      // Store what was read. Full passes resume from their cursor; incremental
      // passes restart from their watermark next cycle, which is idempotent.
      for (const pending of passes) {
        if (!pending.done) paused.push(pending.language)
      }
      pauseReason = 'bytes'
      break
    }
  }

  const next: Record<string, ProjectionState> = {}
  const complete: Partial<Record<string, boolean>> = {}
  for (const pass of passes) {
    if (pass.restart) {
      // Reuse the same snapshot when the server rejected an incomplete pass:
      // it was already charged, and restarting from lemma 0 is idempotent. Only
      // a completed-pass rejection must take a new snapshot next cycle.
      if (pass.restartSnapshot === null) {
        const resetIndex = resetLanguages.indexOf(pass.language)
        if (resetIndex !== -1) resetLanguages.splice(resetIndex, 1)
      }
      next[pass.language] = {
        complete: false,
        snapshot: pass.restartSnapshot,
        cursor: null,
        hydratedAt: pass.previous.hydratedAt,
      }
      complete[pass.language] = false
      continue
    }

    const state: ProjectionState = pass.done
      ? {
          complete: true,
          // An incremental pass advances its watermark to this cycle's server
          // snapshot. Rows changed after it are re-read by the overlap.
          snapshot: pass.full ? pass.bound : snapshot,
          cursor: null,
          hydratedAt: pass.full ? new Date().toISOString() : pass.previous.hydratedAt,
        }
      : {
          // A fresh pass is not complete at any stored watermark. Only a
          // resumed pass may still describe an already-complete language.
          complete: pass.fresh ? false : pass.previous.complete,
          // A paused incremental pass keeps its prior watermark: advancing it
          // now would skip the rows it did not read. Its cursor is always null
          // so the next cycle re-reads from the watermark.
          snapshot: pass.full ? pass.bound : pass.previous.snapshot,
          cursor:
            pass.full && pass.cursor !== null
              ? { languageCode: pass.language, lemma: pass.cursor }
              : null,
          hydratedAt: pass.previous.hydratedAt,
        }
    next[pass.language] = state
    complete[pass.language] = state.complete
  }

  return {
    rows,
    pull: {
      languages: targets,
      full: fullLanguages,
      reset: resetLanguages,
      next,
      complete,
      paused,
      pauseReason,
      quota,
      snapshot,
    },
  }
}

/**
 * Reads one server snapshot into local-shaped rows.
 *
 * The initial (no pull snapshot) path deliberately reads no `word_states` and
 * no occurrences: a new device hydrates both from the wordbook projection, so
 * downloading 200k source rows only to derive the same wordbook is waste. An
 * R2 device keeps its local rows and gets the projection alongside them.
 *
 * Incremental occurrence reads are limited to documents whose occurrence
 * version actually moved. A document only opened elsewhere has a newer
 * `server_updated_at` but an unchanged `occurrences_updated_at`, so it must not
 * download its occurrence rows.
 */
export async function pull(
  userId: string,
  db: SupabaseClient<Database>,
  since: PullWatermarks = {},
  options: PullOptions = {},
): Promise<PullResult> {
  const { data: snapshot, error: snapshotError } = await db.rpc('sync_snapshot')
  if (snapshotError) throw snapshotError

  const initial = since.snapshot === undefined
  const lower = since.snapshot
    ? new Date(Date.parse(since.snapshot) - SNAPSHOT_OVERLAP_MS).toISOString()
    : undefined
  const timestampOptions = {
    since: lower,
    until: snapshot,
    sinceColumn: 'server_updated_at',
  }

  const [languageRows, documentRows, tombstones, folders, wordStates, totals] = await Promise.all([
    fetchAll<{ language_code: string }>(db, 'user_languages', userId, 'language_code', 'language_code'),
    // Metadata only: the text is fetched when a document is opened (content.ts).
    fetchAll<DocumentMetadataRow>(
      db,
      'documents',
      userId,
      'id',
      DOCUMENT_METADATA_COLUMNS,
      timestampOptions,
    ),
    fetchAll<DocumentTombstoneRow>(db, 'document_tombstones', userId, 'document_id', '*', timestampOptions),
    fetchAll<FolderRow>(db, 'folders', userId, 'id', '*', timestampOptions),
    // A first sync hydrates states from the projection instead.
    initial
      ? Promise.resolve([] as WordStateRow[])
      : fetchAll<WordStateRow>(db, 'word_states', userId, 'id', '*', timestampOptions),
    Promise.all([
      countRows(db, 'documents', userId, snapshot),
      countRows(db, 'word_states', userId, snapshot),
    ]).then(([documentCount, wordCount]) => ({ documents: documentCount, wordStates: wordCount })),
  ])

  const documents = documentRows.map(documentMetadataFromRow)

  let occurrences: OccurrenceRow[] = []
  let occurrenceDocumentIds: string[] = []
  if (!initial) {
    // Legacy rows without occurrence versions are fetched: an unknown version
    // is not evidence that the rows are unchanged.
    occurrenceDocumentIds = documentRows
      .filter((row) => {
        const updated = row.occurrences_updated_at
        if (updated === undefined || updated === null) return true
        if (lower === undefined) return true
        const at = Date.parse(updated)
        return Number.isNaN(at) || at > Date.parse(lower)
      })
      .map((row) => row.id)
    for (const part of chunk(occurrenceDocumentIds, 50)) {
      occurrences.push(
        ...(await fetchAll<OccurrenceRow>(db, 'word_occurrences', userId, 'id', '*', {
          documentIds: part,
        })),
      )
    }
  }

  // Reset is decided per language inside `pullProjection`: a reset only starts
  // a new pass when no full pass is already in progress. Discarding the stored
  // map here would restart a paused reset from lemma 0 on every cycle.
  const projectionState = options.projectionState ?? (await readProjectionState(userId))
  const targetLanguages = [
    ...(options.languages ?? []),
    ...languageRows.map((row) => row.language_code),
  ]
  const projection = await pullProjection(
    db,
    userId,
    snapshot,
    targetLanguages,
    projectionState,
    options.resetProjection === true,
    options.projectionByteBudget ?? PROJECTION_BYTE_BUDGET,
  )

  return {
    languages: languageRows.map((row) => row.language_code),
    documents,
    tombstones: tombstones.map(documentTombstoneFromRow),
    folders: folders.map(folderFromRow),
    wordStates: wordStates.map(wordStateFromRow),
    occurrences,
    occurrenceDocumentIds,
    wordbookEntries: projection.rows,
    projection: projection.pull,
    totals,
    watermarks: { snapshot },
  }
}
