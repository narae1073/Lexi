import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import { STORES, idbDelete, idbGetAll, idbPut } from '../../lib/storage/localDb'
import type { Document } from '../../types'
import type { WordOccurrence } from '../../app/stores/occurrences'
import { useWordStatesStore } from '../../app/stores/wordStates'
import { LEMMA_VERSION } from '../../features/reader/surfaceLemma'
import { changedOccurrenceDocuments, pushOccurrences, syncOnce } from './sync'

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
    folders: [],
    word_states: [],
    word_occurrences: [],
  }
  const upsertCalls: Record<string, number> = {}
  const orders: Record<string, string> = {}
  let nextOccurrenceId = 1

  const keyOf = (table: string, row: Record<string, unknown>): string => {
    if (table === 'word_states') return `${row.user_id}|${row.language_code}|${row.lemma}`
    if (table === 'documents') return String(row.id)
    if (table === 'folders') return String(row.id)
    if (table === 'user_languages') return `${row.user_id}|${row.language_code}`
    return String(row.id ?? `${row.user_id}|${row.lemma}|${row.surface}`)
  }

  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {}
      const range = { from: 0, to: Infinity }
      let orderColumn = ''
      // 실제 클라이언트처럼 delete().eq() 체이닝을 받는다 — 실행은 await 때다
      let deleting = false

      const matches = (row: Record<string, unknown>): boolean => {
        for (const [k, v] of Object.entries(filters)) {
          if (k.startsWith('__in__')) {
            if (!(v as unknown[]).includes(row[k.slice('__in__'.length)])) return false
            continue
          }
          if (row[k] !== v) return false
        }
        return true
      }

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
          orders[table] = column
          return query
        },
        range: (from: number, to: number) => {
          range.from = from
          range.to = to
          return query
        },
        upsert: async (rows: Record<string, unknown>[]) => {
          upsertCalls[table] = (upsertCalls[table] ?? 0) + 1
          for (const row of rows) {
            const key = keyOf(table, row)
            const at = tables[table].findIndex((r) => keyOf(table, r) === key)
            if (at >= 0) tables[table][at] = { ...tables[table][at], ...row }
            else tables[table].push(row)
          }
          return { data: null, error: null }
        },
        insert: async (rows: Record<string, unknown>[]) => {
          for (const row of rows) {
            tables[table].push({ id: nextOccurrenceId++, ...row })
          }
          return { data: null, error: null }
        },
        delete: () => {
          deleting = true
          return query
        },
        then: async (resolve: (value: { data: unknown[] | null; error: null }) => unknown) => {
          // 지우기는 await 때 실행된다 — 필터가 뒤에 붙기 때문이다
          if (deleting) {
            tables[table] = tables[table].filter((row) => !matches(row))
            return resolve({ data: null, error: null })
          }

          let rows = tables[table].filter(matches)

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
    rows: (table: string) => tables[table],
    upsertCalls: (table: string) => upsertCalls[table] ?? 0,
    orderOf: (table: string) => orders[table],
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
  favorite: false,
  favoriteUpdatedAt: '2026-10-02T00:00:00.000Z',
  starAngle: 0,
  starColor: '#eab308',
})

/** 서버에 단어 상태를 몇 개 심는다 */
function seedWords(server: Server, count: number, start = 0) {
  for (let i = start; i < start + count; i++) {
    server.add('word_states', {
      id: `ws-${start + i}`,
      user_id: 'user-1',
      language_code: 'fr',
      lemma: `mot${String(i).padStart(4, '0')}`,
      status: 'known',
      seen_count: 1,
      first_seen_at: '2026-10-01T00:00:00+00:00',
      last_seen_at: '2026-10-05T00:00:00+00:00',
      is_favorite: false,
      favorite_updated_at: '2026-10-01T00:00:00+00:00',
      star_angle: 0,
      star_color: '#eab308',
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
  await idbDelete(STORES.documentMeta, doc.id)
  await idbDelete(STORES.wordOccurrences, [doc.id, 'chat'])
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

  /**
   * 표시를 없애면 서버 행도 지워지고 다른 기기에도 전해진다.
   *
   * 없앤 것을 upsert 하면 'unsure' 로 굳어 되살아난다. 그래서 상태 없는 행은
   * 지우기로 간다. 지운 뒤에는 조용해야 한다 — 매번 지우기를 보내면
   * '보낸 단어' 숫자가 거짓말을 한다.
   */
  it('A 기기가 없앤 표시는 B 기기에서도 없어진다', async () => {
    const server = memoryServer()
    await idbPut(STORES.documents, doc)
    await idbPut(STORES.wordStates, { ...wordState('été'), status: 'known' })
    await sync(server)
    expect(server.count('word_states')).toBe(1)

    // A 기기에서 표시를 없앤다 — clearStatus 와 같은 모양(상태만 뺀다)
    const stored = await idbGetAll<Record<string, unknown>>(STORES.wordStates)
    const row = stored.find((r) => r['lemma'] === 'été')
    if (!row) throw new Error('기록이 없다')
    const { status: _removed, ...kept } = row
    await idbPut(STORES.wordStates, {
      ...kept,
      lastSeenAt: '2026-10-07T00:00:00.000Z',
    })

    const report = await sync(server)
    expect(server.count('word_states')).toBe(0)
    // 지운 것은 '보낸 단어' 가 아니다
    expect(report.pushed).toBe(0)

    // A 기기가 한 번 더 돌려도 조용하다 — 지우기 무한 반복이 없다
    const reportA2 = await sync(server)
    expect(reportA2.pushed).toBe(0)
    expect(server.count('word_states')).toBe(0)

    // B 기기: 로컬에 아무것도 없다
    await clearLocalWords()
    const reportB = await sync(server)
    expect(reportB.pulled).toBe(0)
    expect(await idbGetAll(STORES.wordStates)).toHaveLength(0)
  })

  /** 별도 서버를 타야 한다 — 이 기기에서만 빛나면 반쪽이다 */
  it('A 기기의 별이 B 기기에 전해진다', async () => {
    const server = memoryServer()
    await idbPut(STORES.documents, doc)
    await idbPut(STORES.wordStates, {
      ...wordState('été'),
      favorite: true,
      favoriteUpdatedAt: '2026-10-06T00:00:00.000Z',
      starAngle: 15,
      starColor: '#ef4444',
    })
    await sync(server)

    // B 기기: 로컬에 아무것도 없다
    await clearLocalWords()
    await sync(server)

    const local = await idbGetAll<{ lemma: string; favorite: boolean; starAngle: number; starColor: string }>(
      STORES.wordStates,
    )
    expect(local.find((r) => r.lemma === 'été')?.favorite).toBe(true)
    // 꾸밈도 함께 간다 — 기울기만 다른 별이 되면 안 된다
    expect(local.find((r) => r.lemma === 'été')?.starAngle).toBe(15)
    expect(local.find((r) => r.lemma === 'été')?.starColor).toBe('#ef4444')
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

  it('단어 상태는 고유한 열(id)로 페이지를 넘긴다 — lemma 는 언어 사이에서 겹친다', async () => {
    const server = memoryServer(1000)
    await idbPut(STORES.documents, doc)
    seedWords(server, 1001)
    await clearLocalWords()
    await sync(server)

    expect(server.orderOf('word_states')).toBe('id')
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
    char_start: 0,
    char_end: lemma.length,
    sentence: '',
    occurrences_count: 1,
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

  it('문장이 바뀌면 보낸다 — 표기만 같다고 같은 기록이 아니다', () => {
    const merged = [state('été', { sentence: '새 문장' })]
    expect(
      changedOccurrenceDocuments(merged, [{ ...row('doc-1', 'été'), sentence: '옛 문장' }]),
    ).toEqual(['doc-1'])
  })

  it('위치가 바뀌면 보낸다', () => {
    const merged = [state('été', { charStart: 10, charEnd: 13 })]
    expect(changedOccurrenceDocuments(merged, [row('doc-1', 'été')])).toEqual(['doc-1'])
  })

  it('등장 횟수가 바뀌면 보낸다', () => {
    const merged = [state('été', { count: 3 })]
    expect(
      changedOccurrenceDocuments(merged, [{ ...row('doc-1', 'été'), occurrences_count: 1 }]),
    ).toEqual(['doc-1'])
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

/** 실제 전송도 문서 단위로 제한되는가 — 필터를 받기만 하고 무시하면 소용없다 */
describe('등장 기록 전송', () => {
  it('onlyDocumentIds 를 주면 그 문서만 갈아끼운다', async () => {
    const server = memoryServer()
    server.add('word_occurrences', {
      id: 1,
      user_id: 'user-1',
      document_id: 'doc-2',
      language_code: 'fr',
      lemma: 'chat',
      surface: 'chat',
      char_start: 0,
      char_end: 4,
      sentence: '옛 문장',
      occurrences_count: 1,
    })

    await pushOccurrences('user-1', [state('été')], server.client, ['doc-1'])

    const rows = server.rows('word_occurrences')
    expect(rows.filter((r) => r.document_id === 'doc-1')).toHaveLength(1)
    expect(rows.filter((r) => r.document_id === 'doc-2')).toHaveLength(1)
    expect(rows.find((r) => r.document_id === 'doc-2')?.sentence).toBe('옛 문장')
  })

  it('서버와 달라진 문서만 다시 보낸다 — 동기화 한 사이클', async () => {
    const server = memoryServer()
    server.add('documents', {
      id: doc.id,
      user_id: 'user-1',
      title: doc.title,
      language_code: 'fr',
      raw_text: doc.rawText,
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
      deleted_at: null,
      folder_id: null,
      folder_updated_at: null,
    })
    server.add('word_occurrences', {
      id: 1,
      user_id: 'user-1',
      document_id: doc.id,
      language_code: 'fr',
      lemma: 'chat',
      surface: 'chat',
      char_start: 0,
      char_end: 4,
      sentence: '옛 문장',
      occurrences_count: 1,
    })

    await idbPut(STORES.documents, doc)
    await idbPut(STORES.documentMeta, {
      documentId: doc.id,
      lemmaVersion: LEMMA_VERSION,
      segmenter: 'intl',
    })
    await idbPut(STORES.wordOccurrences, state('chat', { sentence: '새 문장', charEnd: 4 }))

    await sync(server)

    const rows = server.rows('word_occurrences').filter((r) => r.document_id === doc.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.sentence).toBe('새 문장')
  })
})

describe('큰 변경은 나눠 보낸다', () => {
  it('단어 상태 501개를 한 요청에 몰아 보내지 않는다', async () => {
    const server = memoryServer(0)
    await idbPut(STORES.documents, doc)
    for (let i = 0; i < 501; i++) {
      await idbPut(STORES.wordStates, wordState(`mot${String(i).padStart(4, '0')}`))
    }

    await sync(server)

    expect(server.count('word_states')).toBe(501)
    // 500개씩 나뉘어 두 번 간다 — 한 요청의 본문이 서버 한도를 넘지 않게
    expect(server.upsertCalls('word_states')).toBeGreaterThan(1)
  }, 30_000)
})