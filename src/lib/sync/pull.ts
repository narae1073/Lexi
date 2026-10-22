import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '../supabase/database.types'
import { documentFromRow, documentTombstoneFromRow, folderFromRow, wordStateFromRow } from './mapping'
import type {
  DocumentRow,
  DocumentTombstoneRow,
  FolderRow,
  OccurrenceRow,
  WordStateRow,
} from './mapping'
import type { PullResult, PullWatermarks } from './types'

export const SNAPSHOT_OVERLAP_MS = 5 * 60_000

const PAGE_SIZE = 1000
const MAX_ROWS = 200_000

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

    if (rows.length > MAX_ROWS) {
      throw new Error(
        `${table} 이 ${MAX_ROWS}행을 넘어 동기화를 멈췄습니다 — 데이터를 나눠 주세요`,
      )
    }
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

export async function pull(
  userId: string,
  db: SupabaseClient<Database>,
  since: PullWatermarks = {},
): Promise<PullResult> {
  const { data: snapshot, error: snapshotError } = await db.rpc('sync_snapshot')
  if (snapshotError) throw snapshotError

  const lower = since.snapshot
    ? new Date(Date.parse(since.snapshot) - SNAPSHOT_OVERLAP_MS).toISOString()
    : undefined
  const timestampOptions = {
    since: lower,
    until: snapshot,
    sinceColumn: 'server_updated_at',
  }

  const [languageRows, documents, tombstones, folders, wordStates, totals] = await Promise.all([
    fetchAll<{ language_code: string }>(db, 'user_languages', userId, 'language_code', 'language_code'),
    fetchAll<DocumentRow>(db, 'documents', userId, 'id', '*', timestampOptions),
    fetchAll<DocumentTombstoneRow>(db, 'document_tombstones', userId, 'document_id', '*', timestampOptions),
    fetchAll<FolderRow>(db, 'folders', userId, 'id', '*', timestampOptions),
    fetchAll<WordStateRow>(db, 'word_states', userId, 'id', '*', timestampOptions),
    Promise.all([
      countRows(db, 'documents', userId, snapshot),
      countRows(db, 'word_states', userId, snapshot),
    ]).then(([documentCount, wordCount]) => ({ documents: documentCount, wordStates: wordCount })),
  ])

  let occurrences: OccurrenceRow[] = []
  if (since.snapshot === undefined) {
    occurrences = await fetchAll<OccurrenceRow>(db, 'word_occurrences', userId, 'id')
  } else {
    const changedDocumentIds = documents.map((row) => row.id)
    for (const part of chunk(changedDocumentIds, 50)) {
      occurrences.push(
        ...(await fetchAll<OccurrenceRow>(db, 'word_occurrences', userId, 'id', '*', {
          documentIds: part,
        })),
      )
    }
  }

  return {
    languages: languageRows.map((row) => row.language_code),
    documents: documents.map(documentFromRow),
    tombstones: tombstones.map(documentTombstoneFromRow),
    folders: folders.map(folderFromRow),
    wordStates: wordStates.map(wordStateFromRow),
    occurrences,
    totals,
    watermarks: { snapshot },
  }
}
