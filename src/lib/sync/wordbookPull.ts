import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '../supabase/database.types'

/** A wordbook projection row exactly as stored on the server. */
export type ProjectionRow = Database['public']['Tables']['wordbook_entries']['Row']

/**
 * Hard page ceiling. The SQL function clamps to the same value, so a client
 * bug can never turn a page into a whole-table download.
 */
export const PROJECTION_PAGE_MAX = 1000

function clampPageLimit(limit: number): number {
  if (!Number.isFinite(limit)) return PROJECTION_PAGE_MAX
  const whole = Math.trunc(limit)
  if (whole < 1) return 1
  return Math.min(whole, PROJECTION_PAGE_MAX)
}

/**
 * Rejects a page the keyset cannot safely advance over.
 *
 * The cursor is the last lemma of the page in `(language_code, lemma)` order.
 * An out-of-order, duplicated, foreign-language, or other-account page would
 * make that cursor skip or replay rows, so it is an error — never a page the
 * caller persists — rather than something to silently sort.
 */
function assertPage(
  rows: ProjectionRow[],
  userId: string,
  languageCode: string,
): void {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (row.user_id !== userId) {
      throw new Error('projection page contained another account row')
    }
    if (row.language_code !== languageCode) {
      throw new Error(
        `projection page contained language ${row.language_code}, expected ${languageCode}`,
      )
    }
    if (index === 0) continue
    const previous = rows[index - 1]
    const ordered =
      previous.language_code < row.language_code ||
      (previous.language_code === row.language_code && previous.lemma < row.lemma)
    if (!ordered) {
      throw new Error('projection page is not in (language_code, lemma) order')
    }
  }
}

/**
 * Reads one page of a language's wordbook projection.
 *
 * - `snapshot` set: full projection page. Only live entries (`deleted_at is
 *   null`) whose `server_updated_at` is at or before the snapshot are returned.
 *   The caller takes the snapshot from `sync_snapshot()` before the first page
 *   and persists it together with the cursor.
 * - `snapshot` null: incremental page. Soft-deleted entries are included so
 *   the caller can remove local phantoms.
 *
 * `afterLemma` is the last lemma of the previous page (null for the first);
 * `limit` is clamped to {@link PROJECTION_PAGE_MAX}. The server binds the page
 * to the caller's account, orders it by `(language_code, lemma)`, and enforces
 * the same ceiling.
 *
 * Ordering for the caller: store the page's rows first, then persist the new
 * cursor (and the snapshot it came from). Persisting the cursor before the
 * rows are applied is the one way a correct page can still lose data.
 */
export async function pullProjectionPage(
  client: SupabaseClient<Database>,
  userId: string,
  language: string,
  snapshot: string | null,
  afterLemma: string | null,
  limit: number,
): Promise<ProjectionRow[]> {
  const { data, error } = await client.rpc('get_wordbook_projection_page', {
    p_language_code: language,
    p_after_lemma: afterLemma,
    p_snapshot: snapshot,
    p_limit: clampPageLimit(limit),
  })
  if (error) throw error

  const rows = (data ?? []) as ProjectionRow[]
  assertPage(rows, userId, language)
  return rows
}
