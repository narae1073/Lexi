import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import { STORES, idbDelete, idbGetAll, idbPut } from '../../lib/storage/localDb'
import type { Document } from '../../types'
import type { WordOccurrence } from '../../app/stores/occurrences'
import { useWordStatesStore } from '../../app/stores/wordStates'
import { changedOccurrenceDocuments, syncOnce } from './sync'

/**
 * 서버를 흉내낸다 — 두 기기 사이에서만 나타나는 문제를 잡으려면 그것이 필요하다.
 *
 * 실제로 하는 일 중 특히 중요한 것 하나: **한 번에 1000행까지만 준다.**
 * Supabase/PostgREST 의 `max_rows` 가 1000 이고, 이 프로젝트도 그렇다
 * (`supabase/config.toml`). 흉내도 그 제한을 그대로 둔다 — 제한이 없으면 문제가
 * 재현되지 않는다.
 */
function memoryServer(rowCap = 1000) {
  const tables: Record<string, Record<string, unknown>[]> = {
    user_languages: [],
    documents: [],
    word_states: [],
    word_occurrences: [],
  }

  const keyOf = (table: string, row: Record<string, unknown>): string => {
    if (table === 'word_states') return `${row.user_id}|${row.language_code}|${row.lemma}`
    if (table === 'documents') return String(row.id)
    if (table === 'user_languages') return `${row.user_id}|${row.language_code}`
    return String(row.id ?? `${row.user_id}|${row.lemma}|${row.surface}`)
  }

  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {}
      const range = { from: 0, to: Infinity }
      let orderColumn = ''

      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          filters[column] = value
          return query
        },
        in: (column: string, values: unknown[]) => {
          filters[`__in__${column}`] = values
          return query
        },
        order: (column: string) => {
          orderColumn = column
          return query
        },
        range: (from: number, to: number) => {
          range.from = from
          range.to = to
          return query
        },
        upsert: async (rows: Record<string, unknown>[]) => {
          for (const row of rows) {
            const key = keyOf(table, row)
            const at = tables[table].findIndex((r) => keyOf(table, r) === key)
            if (at >= 0) tables[table][at] = { ...tables[table][at], ...row }
            else tables[table].push(row)
          }
          return { data: null, error: null }
        },
        delete: async () => {
          const inKey = Object.keys(filters).find((k) => k.startsWith('__in__'))
          const inValues = (filters[inKey!] ?? []) as unknown[]
          const inColumn = inKey?.slice('__in__'.length)
          tables[table] = tables[table].filter((row) => {
            if (inColumn && !inValues.includes(row[inColumn])) return true
            for (const [k, v] of Object.entries(filters)) {
              if (k.startsWith('__in__')) continue
              if (row[k] !== v) return true
            }
            return false
          })
          return { data: null, error: null }
        },
        then: async (resolve: (value: { data: unknown[]; error: null }) => unknown) => {
          let rows = tables[table].filter((row) => {
            for (const [k, v] of Object.entries(filters)) {
              if (k.startsWith('__in__')) {
                if (!(v as unknown[]).includes(row[k.slice('__in__'.length)])) return false
                continue
              }
              if (row[k] !== v) return false
            }
            return true
          })

          // 순서를 명시하지 않으면 페이지가 겹치고 빠진다 — 우리가 정해야 한다
          if (orderColumn) {
            rows = [...rows].sort((a, b) =>
              String(a[orderColumn] ?? '').localeCompare(String(b[orderColumn] ?? '')),
            )
          }

          rows = rows.slice(range.from, range.to === Infinity ? undefined : range.to + 1)
          const capped = rowCap > 0 ? rows.slice(0, rowCap) : rows
          return resolve({ data: capped.map((r) => ({ ...r })), error: null })
        },
      }
      return query
    },
  }

  return {
    client: client as never,
    count: (table: string) => tables[table].length,
    add: (table: string, row: Record<string, unknown>) => {
      tables[table].push(row)
    },
  }
}

type Server = ReturnType<typeof memoryServer>

const doc: Document = {
  id: 'doc-1',
  title: 'Le petit renard et la lune',
  languageCode: 'fr',
  rawText: "J'aime d'été.",
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
}

const state = (lemma: string, over: Partial<WordOccurrence> = {}): WordOccurrence => ({
  documentId: doc.id,
  languageCode: 'fr',
  lemma,
  surfaces: [lemma],
  count: 1,
  charStart: 0,
  charEnd: lemma.length,
  sentence: '',
  documentTitle: doc.title,
  recordedAt: 1,
  ...over,
})

const wordState = (lemma: string) => ({
  languageCode: 'fr',
  lemma,
  status: 'known',
  seenCount: 1,
  firstSeenAt: '2026-10-02T00:00:00.000Z',
  lastSeenAt: '2026-10-05T00:00:00.000Z',
})

/** 서버에 단어 상태를 몇 개 심는다 */
function seedWords(server: Server, count: number, start = 0) {
  for (let i = start; i < start + count; i++) {
    server.add('word_states', {
      user_id: 'user-1',
      language_code: 'fr',
      lemma: `mot${String(i).padStart(4, '0')}`,
      status: 'known',
      seen_count: 1,
      first_seen_at: '2026-10-01T00:00:00+00:00',
      last_seen_at: '2026-10-05T00:00:00+00:00',
    })
  }
}

async function clearLocalWords() {
  for (const row of await idbGetAll<{ languageCode: string; lemma: string }>(STORES.wordStates)) {
    await idbDelete(STORES.wordStates, [row.languageCode, row.lemma])
  }
}

const sync = (server: Server) =>
  syncOnce({ userId: 'user-1', languages: ['fr'], db: server.client })

beforeEach(async () => {
  useWordStatesStore.setState({ byKey: {}, loaded: {} })
  await clearLocalWords()
  await idbDelete(STORES.documents, doc.id)
})

/**
 * 두 기기가 하나의 계정을 나눠 쓴다.
 *
 * 기기 사이에서만 나타나는 문제를 한 기기 안에서 잡을 수는 없다. `syncOnce` 는 DB
 * 클라이언트를 주입받으므로 서버를 메모리로 넣을 수 있다.
 */
describe('두 기기가 계정을 나눠 쓴다', () => {
  it('A 기기가 표시한 것이 B 기기에 나타난다', async () => {
    const server = memoryServer()
    await idbPut(STORES.documents, doc)
    for (const lemma of ['été', 'aime']) await idbPut(STORES.wordStates, wordState(lemma))

    const reportA = await sync(server)
    expect(server.count('word_states')).toBe(2)
    expect(reportA.pushed).toBe(2)

    // B 기기: 로컬에 아무것도 없다
    await clearLocalWords()
    expect(await idbGetAll(STORES.wordStates)).toHaveLength(0)

    const reportB = await sync(server)
    expect(reportB.pulled).toBe(2)
    const local = await idbGetAll<{ lemma: string; status: string }>(STORES.wordStates)
    expect(local.map((r) => r.lemma).sort()).toEqual(['aime', 'été'])
    expect(local.every((r) => r.status === 'known')).toBe(true)
  })

  /** 받은 것이 화면에까지 가야 사용자가 본다 — 저장소에 있기만 하면 안 된다 */
  it('받은 것을 화면에 싣는다', async () => {
    const server = memoryServer()
    await idbPut(STORES.documents, doc)
    await idbPut(STORES.wordStates, wordState('été'))
    await sync(server)

    await clearLocalWords()
    useWordStatesStore.setState({ byKey: {}, loaded: {} })
    await sync(server)
    await useWordStatesStore.getState().loadLanguage('fr', { force: true })

    expect(useWordStatesStore.getState().byKey['fr::été']?.status).toBe('known')
  })
})

/**
 * 1000개를 넘는 진도.
 *
 * 회귀: 서버는 한 요청당 1000행까지만 준다. 한 번씩만 읽으면 **1000개를 넘는 진도는
 * 이 기기로 오지 않았다.** 화면에는 '서버에 1000개' 라고 보였는데 실제로는 잘린
 * 것이었다 — 그 숫자를 믿은 나는 '서버에 다 있다' 고 잘못 읽었다.
 *
 * 정확히 1000이라는 숫자가 힌트였고, 원인은 프로젝트 설정에 있었다
 * (`supabase/config.toml` 의 max_rows).
 */
describe('1000개를 넘는 진도도 온다', () => {
  it('1001 개가 서버에 있으면 1001 개를 받는다', async () => {
    const server = memoryServer()
    await idbPut(STORES.documents, doc)
    seedWords(server, 1001)

    await clearLocalWords()
    const report = await sync(server)

    expect(report.serverWords).toBe(1001)
    expect(report.pulled).toBe(1001)
    expect(await idbGetAll(STORES.wordStates)).toHaveLength(1001)
  }, 20_000)

  /** 속이면 무엇도 할 수 없다 — 없는 것과 모르는 것을 구분해야 한다 */
  it('받는 수를 속이지 않는다', async () => {
    const server = memoryServer()
    await idbPut(STORES.documents, doc)
    seedWords(server, 1002)
    await clearLocalWords()

    const report = await sync(server)
    expect(report.serverWords).toBe(1002)
    // 받은 직후에 '이 기기 0' 이라고 하면 상황을 설명하지 못한다
    expect(report.localWords).toBe(1002)
  }, 20_000)

  it('서버가 1000행으로 잘라도 페이지로 끝까지 읽는다', async () => {
    const server = memoryServer(1000) // 실제 서버와 같은 제한
    await idbPut(STORES.documents, doc)
    seedWords(server, 1005)

    await clearLocalWords()
    await sync(server)
    expect(await idbGetAll(STORES.wordStates)).toHaveLength(1005)
  }, 20_000)

  /** 순서를 고정하지 않으면 페이지가 겹치고 빠진다 */
  it('순서를 정해야 페이지가 겹치지 않는다', async () => {
    const server = memoryServer(1000)
    await idbPut(STORES.documents, doc)
    seedWords(server, 1003)
    await clearLocalWords()
    await sync(server)

    const lemmas = new Set(
      (await idbGetAll<{ lemma: string }>(STORES.wordStates)).map((r) => r.lemma),
    )
    expect(lemmas.size).toBe(1003)
  }, 20_000)
})

/**
 * 등장 기록은 **달라진 문서만** 보낸다.
 *
 * 회귀: 동기화가 이 기기의 기록을 문서 단위로 통째로 지우고 다시 넣었다. 한 번 동기화할
 * 때마다 **서버의 모든 등장 기록이 이 기기의 것으로 교체**됐다. 어느 한 기기의 기록이 덜
 * 계산되어 있으면 그것이 서버 전체를 덮어썼다.
 */
describe('등장 기록은 달라진 문서만 보낸다', () => {
  const row = (documentId: string, lemma: string, surface = lemma) => ({
    document_id: documentId,
    lemma,
    surface,
  })

  it('비어 있으면 아무것도 보내지 않는다 — 매번 덮어쓰지 않는다', () => {
    expect(changedOccurrenceDocuments([state('été')], [row('doc-1', 'été')])).toEqual([])
  })

  it('서버에 없는 문서는 보낸다 — 다른 기기는 아직 모른다', () => {
    expect(changedOccurrenceDocuments([state('été')], [])).toEqual(['doc-1'])
  })

  it('표기가 하나 늘었으면 보낸다', () => {
    const merged = [state('été', { surfaces: ["l'été", 'été'] })]
    expect(changedOccurrenceDocuments(merged, [row('doc-1', 'été')])).toEqual(['doc-1'])
  })

  /** 덮어쓰면 안 된다 — 상대 기기가 영영 잃는다 */
  it('다른 기기에만 있는 기록이 있으면 덮어쓰지 않는다', () => {
    const remote = [row('doc-1', 'été'), row('doc-1', 'chat'), row('doc-1', 'lune')]
    expect(changedOccurrenceDocuments([state('été')], remote)).toEqual(['doc-1'])
  })

  it('문서를 여러 개 다루면 바뀐 것만 뽑는다', () => {
    const merged = [state('a'), state('b', { documentId: 'doc-2' })]
    expect(changedOccurrenceDocuments(merged, [row('doc-1', 'a')])).toEqual(['doc-2'])
  })
})