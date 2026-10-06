import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import { STORES, idbDelete, idbGetAll, idbPut } from '../../lib/storage/localDb'
import { useWordStatesStore } from '../../app/stores/wordStates'
import type { Document } from '../../types'
import { syncOnce } from './sync'

/**
 * 서버를 흉내낸다.
 *
 * 진짜 문제가 두 기기 사이에만 나타나므로, 한 기기 안에서만 시험하면 영영 잡히지 않는다.
 * `syncOnce` 는 DB 클라이언트를 주입받으므로 메모리 서버를 끼워 넣을 수 있다.
 *
 * 최소한의 PostgREST 흉내: from().select().eq() / upsert / delete().eq().in()
 */
function memoryServer() {
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
          const inColumn = Object.keys(filters).find((k) => k.startsWith('__in__'))
          const inValues = (filters[inColumn!] ?? []) as unknown[]
          const column = inColumn?.slice('__in__'.length)
          tables[table] = tables[table].filter((row) => {
            if (column && !inValues.includes(row[column])) return true
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
          rows = rows.map((r) => ({ ...r }))
          return resolve({ data: rows, error: null })
        },
      }
      return query
    },
  }

  return {
    client: client as never,
    count: (table: string) => tables[table].length,
    rows: (table: string) => tables[table],
  }
}

const doc: Document = {
  id: 'doc-1',
  title: 'Le petit renard et la lune',
  languageCode: 'fr',
  rawText: "J'aime d'été.",
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
}

/**
 * 두 기기가 하나의 계정을 쓴다.
 *
 * A 기기에서 표시한 단어 상태가 서버를 거쳐 B 기기에 나타나야 한다. 사용자가 겪은
 * 증상은 '문서는 오는데 단어 상태는 안 온다' 였다 — 같은 서버를 두 기기가 나눠 쓰는
 * 상황이 여기서 재현되어야만 잡을 수 있다.
 */
describe('두 기기가 계정을 나눠 쓴다', () => {
  beforeEach(async () => {
    useWordStatesStore.setState({ byKey: {}, loaded: {} })
    // 기기 사이에 남은 데이터를 비운다
    for (const row of await idbGetAll<{ languageCode: string; lemma: string }>(STORES.wordStates)) {
      await idbDelete(STORES.wordStates, [row.languageCode, row.lemma])
    }
    await idbDelete(STORES.documents, doc.id)
  })

  /** B 기기처럼 보이게 한다 — 서버만 보고 시작하는 기기 */
  const forgetEverything = async () => {
    for (const row of await idbGetAll<{ languageCode: string; lemma: string }>(STORES.wordStates)) {
      await idbDelete(STORES.wordStates, [row.languageCode, row.lemma])
    }
  }

  it('A 기기가 표시한 것이 B 기기에 나타난다', async () => {
    const server = memoryServer()
    await idbPut(STORES.documents, doc)

    // ── A 기기: 두 단어를 표시하고 동기화 ──
    for (const lemma of ['été', 'aime']) {
      await idbPut(STORES.wordStates, {
        languageCode: 'fr',
        lemma,
        status: 'known',
        seenCount: 1,
        firstSeenAt: '2026-10-02T00:00:00.000Z',
        lastSeenAt: '2026-10-05T00:00:00.000Z',
      })
    }

    const reportA = await syncOnce({ userId: 'user-1', languages: ['fr'], db: server.client })
    expect(server.count('word_states')).toBe(2)
    expect(reportA.pushed).toBe(2)

    // ── B 기기: 로컬에 아무것도 없다 ──
    await forgetEverything()
    expect(await idbGetAll(STORES.wordStates)).toHaveLength(0)

    const reportB = await syncOnce({ userId: 'user-1', languages: ['fr'], db: server.client })

    // 서버의 것이 이 기기로 들어와야 한다
    expect(reportB.pulled).toBe(2)
    const local = await idbGetAll<{ lemma: string; status: string }>(STORES.wordStates)
    expect(local.map((r) => r.lemma).sort()).toEqual(['aime', 'été'])
    expect(local.every((r) => r.status === 'known')).toBe(true)
  })

  /** 받은 것을 화면에까지 싣는다 — 화면까지 가야 사용자가 본다 */
  it('받은 것을 화면에 싣는다', async () => {
    const server = memoryServer()
    await idbPut(STORES.documents, doc)
    await idbPut(STORES.wordStates, {
      languageCode: 'fr',
      lemma: 'été',
      status: 'known',
      seenCount: 1,
      firstSeenAt: '2026-10-02T00:00:00.000Z',
      lastSeenAt: '2026-10-05T00:00:00.000Z',
    })
    await syncOnce({ userId: 'user-1', languages: ['fr'], db: server.client })

    // B 기기
    await forgetEverything()
    useWordStatesStore.setState({ byKey: {}, loaded: {} })
    await syncOnce({ userId: 'user-1', languages: ['fr'], db: server.client })
    // 앱이 시작할 때 이미 읽은 상태였다고 해도, 동기화 뒤에는 다시 읽는다
    await useWordStatesStore.getState().loadLanguage('fr', { force: true })

    expect(useWordStatesStore.getState().byKey['fr::été']?.status).toBe('known')
  })

  it('빈 기기는 서버에서 받아 온다', async () => {
    const server = memoryServer()
    await idbPut(STORES.documents, doc)
    await idbPut(STORES.wordStates, {
      languageCode: 'fr',
      lemma: 'été',
      status: 'known',
      seenCount: 1,
      firstSeenAt: '2026-10-02T00:00:00.000Z',
      lastSeenAt: '2026-10-05T00:00:00.000Z',
    })
    await syncOnce({ userId: 'user-1', languages: ['fr'], db: server.client })
    expect(server.count('word_states')).toBe(1)

    await forgetEverything()
    const pulled = await syncOnce({ userId: 'user-1', languages: ['fr'], db: server.client })
    expect(pulled.pulled).toBe(1)
  })
})

