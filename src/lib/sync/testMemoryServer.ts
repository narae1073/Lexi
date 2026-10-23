/** Small PostgREST stand-in used by sync integration tests. */
export function memoryServer(
  rowCap = 1000,
  initialSnapshot = '2026-10-30T00:00:00.000Z',
) {
  const tables: Record<string, Record<string, unknown>[]> = {
    user_languages: [],
    documents: [],
    document_tombstones: [],
    folders: [],
    word_states: [],
    word_occurrences: [],
    wordbook_entries: [],
  }
  const upsertCalls: Record<string, number> = {}
  const orders: Record<string, string> = {}
  const rpcCalls: Record<string, number> = {}
  let snapshot = initialSnapshot
  let nextOccurrenceId = 1
  let pageHook: ((table: string, page: number) => void | Promise<void>) | undefined
  const pages: Record<string, number> = {}
  const upsertRejects = new Map<string, (row: Record<string, unknown>) => boolean>()
  const rpcRejects = new Map<string, (args: Record<string, unknown>) => boolean>()

  /** Server-order comparison (timestamps numerically, everything else like SQL text). */
  const compare = (a: unknown, b: unknown): number => {
    if (typeof a === 'number' && typeof b === 'number') return a - b
    if (
      typeof a === 'string' &&
      typeof b === 'string' &&
      /^\d{4}-\d{2}-\d{2}T/.test(a) &&
      /^\d{4}-\d{2}-\d{2}T/.test(b)
    ) {
      const aTime = Date.parse(a)
      const bTime = Date.parse(b)
      if (!Number.isNaN(aTime) && !Number.isNaN(bTime)) return aTime - bTime
    }
    return String(a ?? '').localeCompare(String(b ?? ''))
  }

  const keyOf = (table: string, row: Record<string, unknown>): string => {
    if (table === 'word_states') return `${row.user_id}|${row.language_code}|${row.lemma}`
    if (table === 'documents') return String(row.id)
    if (table === 'document_tombstones') return `${row.user_id}|${row.document_id}`
    if (table === 'folders') return String(row.id)
    if (table === 'user_languages') return `${row.user_id}|${row.language_code}`
    if (table === 'wordbook_entries') return `${row.user_id}|${row.language_code}|${row.lemma}`
    return String(row.id ?? `${row.user_id}|${row.lemma}|${row.surface}`)
  }

  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {}
      const range = { from: 0, to: Infinity }
      let orderColumn = ''
      let limitCount = Infinity
      let greaterThan: { column: string; value: unknown } | null = null
      let countMode = false
      let deleting = false
      /** Columns of the last `select`; null means every column. */
      let selectedColumns: string[] | null = null

      const compareValues = compare

      const matches = (row: Record<string, unknown>): boolean => {
        for (const [key, value] of Object.entries(filters)) {
          if (key.startsWith('__in__')) {
            if (!(value as unknown[]).includes(row[key.slice('__in__'.length)])) return false
            continue
          }
          if (key.startsWith('__gte__')) {
            if (compareValues(row[key.slice('__gte__'.length)], value) < 0) return false
            continue
          }
          if (key.startsWith('__lte__')) {
            if (compareValues(row[key.slice('__lte__'.length)], value) > 0) return false
            continue
          }
          if (row[key] !== value) return false
        }
        return true
      }

      const query = {
        select: (columns?: string, options?: { count?: string; head?: boolean }) => {
          countMode = options?.count === 'exact' && options?.head === true
          // PostgREST returns only the requested columns. The pull relies on
          // this to keep `raw_text` out of the document list, so the stand-in
          // must honour it rather than leaking every column.
          selectedColumns =
            columns === undefined || columns.trim() === '' || columns.trim() === '*'
              ? null
              : columns.split(',').map((column) => column.trim())
          return query
        },
        eq: (column: string, value: unknown) => {
          filters[column] = value
          return query
        },
        in: (column: string, values: unknown[]) => {
          filters[`__in__${column}`] = values
          return query
        },
        gte: (column: string, value: unknown) => {
          filters[`__gte__${column}`] = value
          return query
        },
        lte: (column: string, value: unknown) => {
          filters[`__lte__${column}`] = value
          return query
        },
        order: (column: string) => {
          orderColumn = column
          orders[table] = column
          return query
        },
        range: (from: number, to: number) => {
          range.from = from
          range.to = to
          return query
        },
        limit: (count: number) => {
          limitCount = count
          return query
        },
        gt: (column: string, value: unknown) => {
          greaterThan = { column, value }
          return query
        },
        upsert: async (rows: Record<string, unknown>[]) => {
          upsertCalls[table] = (upsertCalls[table] ?? 0) + 1
          // A real upsert statement is atomic: one rejected row rejects the chunk.
          const reject = upsertRejects.get(table)
          if (reject && rows.some((row) => reject(row))) {
            return { data: null, error: { message: `${table} row rejected` } }
          }
          for (const raw of rows) {
            // Server-owned watermark columns are absent from client payloads.
            // Fill them like the real triggers do so incremental reads work.
            const row = { ...raw }
            if (
              (table === 'documents' ||
                table === 'folders' ||
                table === 'word_states' ||
                table === 'document_tombstones' ||
                table === 'wordbook_entries') &&
              row.server_updated_at === undefined
            ) {
              row.server_updated_at = snapshot
            }
            const key = keyOf(table, row)
            const at = tables[table].findIndex((existing) => keyOf(table, existing) === key)
            if (table === 'documents') {
              const existing = at >= 0 ? tables[table][at] : undefined
              if (row.raw_text !== undefined) {
                // The real triggers maintain char_count and content_updated_at.
                if (row.char_count === undefined) {
                  row.char_count = Array.from(String(row.raw_text)).length
                }
                if (existing === undefined || existing.raw_text !== row.raw_text) {
                  row.content_updated_at = row.content_updated_at ?? snapshot
                }
              }
              // A metadata-only upsert carries no raw_text: the existing text and
              // its version columns must stay exactly as they were.
            }
            if (at >= 0) tables[table][at] = { ...tables[table][at], ...row }
            else tables[table].push(row)
          }
          return { data: null, error: null }
        },
        insert: async (rows: Record<string, unknown>[]) => {
          for (const row of rows) tables[table].push({ id: nextOccurrenceId++, ...row })
          return { data: null, error: null }
        },
        delete: () => {
          deleting = true
          return query
        },
        then: async (
          resolve: (value: { data: unknown[] | null; count?: number; error: null }) => unknown,
        ) => {
          if (deleting) {
            tables[table] = tables[table].filter((row) => !matches(row))
            return resolve({ data: null, error: null })
          }

          let rows = tables[table].filter(matches)
          if (countMode) return resolve({ data: null, count: rows.length, error: null })

          const cursor = greaterThan
          if (cursor) {
            rows = rows.filter((row) => compareValues(row[cursor.column], cursor.value) > 0)
          }
          if (orderColumn) {
            rows = [...rows].sort((a, b) => compareValues(a[orderColumn], b[orderColumn]))
          }
          rows = rows.slice(range.from, range.to === Infinity ? undefined : range.to + 1)
          if (Number.isFinite(limitCount)) rows = rows.slice(0, limitCount)
          const capped = rowCap > 0 ? rows.slice(0, rowCap) : rows
          const data = capped.map((row) => {
            if (selectedColumns === null) return { ...row }
            const picked: Record<string, unknown> = {}
            for (const column of selectedColumns) {
              if (column in row) picked[column] = row[column]
            }
            return picked
          })
          pages[table] = (pages[table] ?? 0) + 1
          await pageHook?.(table, pages[table])
          return resolve({ data, error: null })
        },
      }
      return query
    },
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      rpcCalls[name] = (rpcCalls[name] ?? 0) + 1
      const rejectRpc = rpcRejects.get(name)
      if (rejectRpc && rejectRpc(args)) {
        return { data: null, error: { message: `${name} rejected` } }
      }
      if (name === 'sync_snapshot') return { data: snapshot, error: null }
      if (
        name === 'get_wordbook_projection_page' ||
        name === 'get_wordbook_projection_page_bounded'
      ) {
        const language = String(args.p_language_code)
        const after = args.p_after_lemma as string | null
        const upper = args.p_snapshot as string | null
        const updatedSince = args.p_updated_since as string | null
        if (upper !== null && updatedSince !== null) {
          return {
            data: null,
            error: {
              message:
                'pass p_snapshot for a full page or p_updated_since for an incremental page, not both',
            },
          }
        }
        const limit = Math.min(
          Math.max(Math.trunc(Number(args.p_limit ?? 1000)) || 1000, 1),
          1000,
        )
        const all = tables.wordbook_entries
          .filter(
            (row) =>
              row.language_code === language &&
              (after === null || compare(row.lemma, after) > 0) &&
              (upper === null ||
                (compare(row.server_updated_at, upper) <= 0 && !row.deleted_at)) &&
              (updatedSince === null ||
                compare(row.server_updated_at, updatedSince) > 0),
          )
          .sort((a, b) => compare(a.lemma, b.lemma))
        const page = all.slice(0, limit).map((row) => ({ ...row }))
        if (name === 'get_wordbook_projection_page') {
          return { data: page, error: null }
        }
        // Mirror the server's ~1 MiB byte cap. A single oversized row is still
        // returned, and hasMore says the language continues.
        const budget = 1024 * 1024
        const picked: Record<string, unknown>[] = []
        let bytes = 0
        for (const row of page) {
          const size = JSON.stringify(row).length
          if (picked.length > 0 && bytes + size > budget) break
          picked.push(row)
          bytes += size
        }
        const hasMore = picked.length < all.length
        const last = picked[picked.length - 1]
        return {
          data: {
            rows: picked,
            hasMore,
            nextCursor: last === undefined ? after : String(last.lemma),
          },
          error: null,
        }
      }
      if (name === 'get_document_payload') {
        const document = tables.documents.find(
          (row) => row.id === args.p_document_id && row.user_id === 'user-1',
        )
        if (document === undefined) return { data: null, error: null }
        const occurrences = tables.word_occurrences
          .filter(
            (row) =>
              row.document_id === document.id && row.user_id === 'user-1',
          )
          .sort(
            (a, b) =>
              Number(a.char_start) - Number(b.char_start) ||
              Number(a.char_end) - Number(b.char_end) ||
              compare(a.lemma, b.lemma) ||
              compare(a.surface, b.surface),
          )
          .map((row) => ({
            languageCode: row.language_code,
            lemma: row.lemma,
            surface: row.surface,
            charStart: row.char_start,
            charEnd: row.char_end,
            sentence: row.sentence,
            occurrencesCount: row.occurrences_count ?? 1,
          }))
        return {
          data: {
            rawText: String(document.raw_text ?? ''),
            contentUpdatedAt: document.content_updated_at ?? null,
            occurrencesUpdatedAt: document.occurrences_updated_at ?? null,
            occurrences,
          },
          error: null,
        }
      }
      if (name === 'get_document_content_page') {
        const document = tables.documents.find(
          (row) => row.id === args.p_document_id && row.user_id === 'user-1',
        )
        if (document === undefined) return { data: null, error: null }
        // Page by code point, like Postgres char_length/substr.
        const characters = Array.from(String(document.raw_text ?? ''))
        const after = Math.max(Math.trunc(Number(args.p_after_char ?? 0)) || 0, 0)
        const limit = Math.min(
          Math.max(Math.trunc(Number(args.p_max_chars ?? 262144)) || 262144, 1),
          1_000_000,
        )
        const pageText = characters.slice(after, after + limit).join('')
        const nextOffset = Math.min(after + Array.from(pageText).length, characters.length)
        return {
          data: {
            rawText: pageText,
            contentUpdatedAt: document.content_updated_at ?? null,
            charCount: characters.length,
            nextOffset,
            done: nextOffset >= characters.length,
          },
          error: null,
        }
      }
      if (name === 'touch_document') {
        const document = tables.documents.find(
          (row) => row.id === args.p_document_id && row.user_id === 'user-1',
        )
        if (document === undefined) {
          return { data: null, error: { message: 'document not found' } }
        }
        const opened = args.p_opened_at as string | null
        const previous = document.last_opened_at as string | null | undefined
        if (
          opened !== null &&
          opened !== undefined &&
          (previous === null || previous === undefined || compare(opened, previous) > 0)
        ) {
          document.last_opened_at = opened
          document.server_updated_at = snapshot
        }
        return { data: null, error: null }
      }
      if (name !== 'replace_word_occurrences') {
        return { data: null, error: { message: `unknown rpc ${name}` } }
      }
      const documentId = String(args.p_document_id)
      const rows = (args.p_rows ?? []) as Record<string, unknown>[]
      tables.word_occurrences = tables.word_occurrences.filter(
        (row) => !(row.user_id === 'user-1' && row.document_id === documentId),
      )
      for (const row of rows) {
        tables.word_occurrences.push({
          id: nextOccurrenceId++,
          user_id: 'user-1',
          document_id: documentId,
          ...row,
        })
      }
      return { data: null, error: null }
    },
  }

  const server = {
    client: client as never,
    count: (table: string) => tables[table].length,
    rows: (table: string) => tables[table],
    upsertCalls: (table: string) => upsertCalls[table] ?? 0,
    orderOf: (table: string) => orders[table],
    rpcCalls: (name: string) => rpcCalls[name] ?? 0,
    setSnapshot: (value: string) => {
      snapshot = value
    },
    afterPage: (hook: typeof pageHook) => {
      pageHook = hook
    },
    add: (table: string, row: Record<string, unknown>) => {
      // Seeded documents behave like a real insert: the trigger fills
      // char_count when the fixture did not set it.
      if (table === 'documents' && row.raw_text !== undefined && row.char_count === undefined) {
        row = { ...row, char_count: Array.from(String(row.raw_text)).length }
      }
      tables[table].push(row)
    },
    /** Reject any upsert chunk in `table` containing a matching row. */
    rejectUpsert: (table: string, predicate: ((row: Record<string, unknown>) => boolean) | null) => {
      if (predicate === null) upsertRejects.delete(table)
      else upsertRejects.set(table, predicate)
    },
    /** Reject an RPC call whose arguments match. */
    rejectRpc: (name: string, predicate: ((args: Record<string, unknown>) => boolean) | null) => {
      if (predicate === null) rpcRejects.delete(name)
      else rpcRejects.set(name, predicate)
    },
  }
  return server
}

export type Server = ReturnType<typeof memoryServer>
