import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '../supabase/database.types'

/** A wordbook projection row exactly as stored on the server. */
export type ProjectionRow = Database['public']['Tables']['wordbook_entries']['Row']

/**
 * Hard page ceiling. The SQL function clamps to the same value, so a client
 * bug can never turn a page into a whole-table download.
 */
export const PROJECTION_PAGE_MAX = 1000

/**
 * The number of rows the server will actually return for a requested limit.
 *
 * Callers must test for the end of a language against **this** value, never
 * against the raw requested limit:
 *
 *   const limit = projectionPageLimit(budget)
 *   const rows = await pullProjectionPage(..., limit)
 *   const done = rows.length < limit
 *
 * Requesting more than {@link PROJECTION_PAGE_MAX} is clamped by both this
 * helper and the server; comparing against the raw request would mistake a
 * clamped full page for the end.
 */
export function projectionPageLimit(limit: number): number {
  if (!Number.isFinite(limit)) return PROJECTION_PAGE_MAX
  const whole = Math.trunc(limit)
  if (whole < 1) return 1
  return Math.min(whole, PROJECTION_PAGE_MAX)
}

/**
 * Rejects a page the caller must not apply or resume from.
 *
 * Row order is the server's job: the database orders by `(language_code,
 * lemma)` with its own collation, which a JS code-unit comparison cannot
 * reproduce (for example `äpfel < école < École < étoile` in a French
 * collation). Re-checking order here would reject valid pages, so only the
 * properties that are order-independent are enforced:
 *
 *   - every row belongs to the requesting account;
 *   - every row is the requested language;
 *   - a lemma appears at most once in a language page (a cursor would
 *     otherwise be ambiguous).
 */
function assertPage(
  rows: ProjectionRow[],
  userId: string,
  languageCode: string,
): void {
  const seen = new Set<string>()
  for (const row of rows) {
    if (row.user_id !== userId) {
      throw new Error('projection page contained another account row')
    }
    if (row.language_code !== languageCode) {
      throw new Error(
        `projection page contained language ${row.language_code}, expected ${languageCode}`,
      )
    }
    if (seen.has(row.lemma)) {
      throw new Error(`projection page repeated lemma ${row.lemma}`)
    }
    seen.add(row.lemma)
  }
}

/**
 * Reads one page of a language's wordbook projection.
 *
 * Modes (exactly one bound per call):
 *
 * - Full projection: pass `snapshot` from `sync_snapshot()`. Only live entries
 *   (`deleted_at is null`) with `server_updated_at <= snapshot` are returned.
 *   Persist the snapshot together with the cursor before the first page, and
 *   resume with the same snapshot until the language is complete.
 * - Incremental projection: pass `updatedSince` (the last incremental
 *   watermark). Soft-deleted rows are included and only rows with
 *   `server_updated_at > updatedSince` are returned, so deletions and
 *   revivals propagate without scanning the language.
 * - Both null: unbounded enumeration. Only for a manual rebuild.
 *
 * Passing both bounds is an error on the server (SQLSTATE 22023).
 *
 * `afterLemma` is the last lemma of the previous page (null for the first);
 * `limit` is clamped by {@link projectionPageLimit}, which the caller must use
 * for its end-of-language test. The server binds the page to the caller's
 * account and enforces the same ceiling.
 *
 * Ordering for the caller: store the page's rows first, then persist the new
 * cursor (and the bound it came from). Persisting the cursor before the rows
 * are applied is the one way a correct page can still lose data.
 */
export async function pullProjectionPage(
  client: SupabaseClient<Database>,
  userId: string,
  language: string,
  snapshot: string | null,
  afterLemma: string | null,
  limit: number,
  updatedSince: string | null = null,
): Promise<ProjectionRow[]> {
  const { data, error } = await client.rpc('get_wordbook_projection_page', {
    p_language_code: language,
    p_after_lemma: afterLemma,
    p_snapshot: snapshot,
    p_updated_since: updatedSince,
    p_limit: projectionPageLimit(limit),
  })
  if (error) throw error

  const rows = (data ?? []) as ProjectionRow[]
  assertPage(rows, userId, language)
  return rows
}
