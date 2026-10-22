import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import { STORES, idbDelete, idbGetAll, idbPut } from '../../lib/storage/localDb'
import type { Document } from '../../types'
import type { WordOccurrence } from '../../app/stores/occurrences'
import { useWordStatesStore } from '../../app/stores/wordStates'
import { LEMMA_VERSION } from '../../features/reader/surfaceLemma'
import { changedOccurrenceDocuments, mergeTombstones, pushOccurrences, syncOnce, type PullWatermarks } from './sync'
import { memoryServer, type Server } from './testMemoryServer'

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
      server_updated_at: '2026-10-05T00:00:00+00:00',
    })
  }
}

async function clearLocalWords() {
  for (const row of await idbGetAll<{ languageCode: string; lemma: string }>(STORES.wordStates)) {
    await idbDelete(STORES.wordStates, [row.languageCode, row.lemma])
  }
}

const sync = (
  server: Server,
  options: { since?: PullWatermarks; pushedAt?: string } = {},
) => syncOnce({ userId: 'user-1', languages: ['fr'], db: server.client, ...options })

beforeEach(async () => {
  useWordStatesStore.setState({ byKey: {}, loaded: {} })
  await clearLocalWords()
  await idbDelete(STORES.documents, doc.id)
  await idbDelete(STORES.documentMeta, doc.id)
  await idbDelete(STORES.wordOccurrences, [doc.id, 'chat'])
  await idbDelete(STORES.documentTombstones, doc.id)
  await idbDelete(STORES.folders, 'folder-1')
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
   * 표시를 없애면 서버 행은 status = null 로 남는다.
   *
   * 행을 지우면 즐겨찾기·메모·횟수가 서버에서 사라지고, 다른 기기가 옛 상태를
   * 다시 올리면 없앰과 되살림이 영원히 번갈아 일어난다. null 행이 '없앰' 의 기록이다.
   */
  it('A 기기가 없앤 표시는 서버에 status null 로 남고 B 기기에서도 없어진다', async () => {
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
    // 행은 남고 상태만 비었다 — 즐겨찾기·메모·횟수를 지우지 않는다
    expect(server.count('word_states')).toBe(1)
    expect(server.rows('word_states')[0]?.status).toBeNull()
    // 없앤 것은 '보낸 단어' 가 아니다
    expect(report.pushed).toBe(0)

    // A 기기가 한 번 더 돌려도 조용하다 — 같은 null 행을 다시 올리지 않는다
    const reportA2 = await sync(server)
    expect(reportA2.pushed).toBe(0)
    expect(server.rows('word_states')[0]?.status).toBeNull()

    // B 기기: 로컬에 아무것도 없다 — null 행을 받아 '미표시' 로 읽는다
    await clearLocalWords()
    const reportB = await sync(server)
    expect(reportB.pulled).toBe(1)
    const local = await idbGetAll<Record<string, unknown>>(STORES.wordStates)
    expect(local).toHaveLength(1)
    expect(local[0]?.status).toBeUndefined()
  })

  /** 없앰은 다른 기기의 옛 상태를 이겨야 한다 — 아니면 두 기기가 영원히 되살린다 */
  it('B 기기의 옛 상태가 A 기기의 없앰을 되살리지 않는다', async () => {
    const server = memoryServer()
    await idbPut(STORES.documents, doc)
    const known = {
      ...wordState('été'),
      status: 'known' as const,
      lastSeenAt: '2026-10-05T00:00:00.000Z',
    }
    await idbPut(STORES.wordStates, known)
    await sync(server)
    expect(server.count('word_states')).toBe(1)

    // A: 더 늦은 시각에 표시를 없앤다
    const stored = await idbGetAll<Record<string, unknown>>(STORES.wordStates)
    const row = stored.find((r) => r['lemma'] === 'été')
    if (!row) throw new Error('기록이 없다')
    const { status: _removed, ...kept } = row
    await idbPut(STORES.wordStates, {
      ...kept,
      lastSeenAt: '2026-10-07T00:00:00.000Z',
    })
    await sync(server)
    expect(server.rows('word_states')[0]?.status).toBeNull()

    // B: 옛 known 행을 그대로 들고 있다가 동기화한다
    await idbPut(STORES.wordStates, known)
    const reportB = await sync(server)
    expect(reportB.pushed).toBe(0) // 옛 상태를 다시 올리지 않는다
    const local = await idbGetAll<Record<string, unknown>>(STORES.wordStates)
    expect(local.find((r) => r['lemma'] === 'été')?.status).toBeUndefined()
    expect(server.rows('word_states')[0]?.status).toBeNull()

    // A 가 한 번 더 돌려도 서버는 null 그대로다
    await sync(server)
    expect(server.rows('word_states')[0]?.status).toBeNull()
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

  it('같은 문서를 다시 보내도 행이 늘지 않는다 — 한 트랜잭션 교체', async () => {
    const server = memoryServer()

    await pushOccurrences('user-1', [state('été')], server.client)
    expect(server.count('word_occurrences')).toBe(1)

    await pushOccurrences(
      'user-1',
      [state('été', { surfaces: ["l'été", 'été'] })],
      server.client,
    )

    const rows = server.rows('word_occurrences')
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.surface).sort()).toEqual(["l'été", 'été'])
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

describe('완전 삭제', () => {
  it('A 가 완전 삭제한 문서는 B 에서 되살아나지 않는다', async () => {
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
    await idbPut(STORES.documents, doc)
    await idbPut(STORES.documentTombstones, {
      documentId: doc.id,
      purgedAt: '2026-10-07T00:00:00.000Z',
    })

    // A 의 purge 는 오프라인이라 서버 삭제가 실패했다고 하자 — 묘비 동기화가 재시도한다
    expect(server.count('documents')).toBe(1)

    // A 동기화: 묘비가 서버로 가고, 서버 문서도 지워지며, 로컬 문서도 정리된다
    await sync(server)
    expect(server.count('documents')).toBe(0)
    expect(server.count('document_tombstones')).toBe(1)
    expect(await idbGetAll(STORES.documents)).toHaveLength(0)

    // B: 문서를 아직 들고 있다가 동기화 — 묘비를 받고 다시 올리지 않는다
    await idbPut(STORES.documents, doc)
    const report = await sync(server)
    expect(report.pushed).toBe(0)
    expect(await idbGetAll(STORES.documents)).toHaveLength(0)
    expect(server.count('documents')).toBe(0)
    expect(server.count('document_tombstones')).toBe(1)
  })
})

describe('문서 묘비 합치기', () => {
  const T1 = '2026-10-01T00:00:00.000Z'
  const T2 = '2026-10-02T00:00:00.000Z'

  it('한 번 지운 것은 남고, 같은 문서는 이른 시각을 쓴다', () => {
    const merged = mergeTombstones(
      [{ documentId: 'd1', purgedAt: T1 }],
      [
        { documentId: 'd1', purgedAt: T2 },
        { documentId: 'd2', purgedAt: T1 },
      ],
    )
    expect(merged).toEqual([
      { documentId: 'd1', purgedAt: T1 },
      { documentId: 'd2', purgedAt: T1 },
    ])
  })
})

describe('증분 동기화', () => {
  const PUSHED_AT = '2026-10-20T00:00:00.000Z'

  it('워터마크 이후에 바뀐 단어만 받는다', async () => {
    const server = memoryServer()
    server.setSnapshot('2026-10-05T00:00:00.000Z')
    await idbPut(STORES.documents, doc)
    seedWords(server, 3)

    const first = await sync(server)
    expect(first.pulled).toBe(3)
    expect(first.watermarks.snapshot).toBe('2026-10-05T00:00:00.000Z')

    // 다른 기기가 단어 하나를 더했다 — 서버 시각이 더 늦다
    server.add('word_states', {
      id: 'ws-new',
      user_id: 'user-1',
      language_code: 'fr',
      lemma: 'nouveau',
      status: 'unsure',
      seen_count: 1,
      first_seen_at: '2026-10-10T00:00:00+00:00',
      last_seen_at: '2026-10-10T00:00:00+00:00',
      is_favorite: false,
      favorite_updated_at: '2026-10-10T00:00:00+00:00',
      star_angle: 0,
      star_color: '#eab308',
      server_updated_at: '2026-10-10T00:00:00+00:00',
    })

    server.setSnapshot('2026-10-10T00:00:00.000Z')
    const second = await sync(server, { since: first.watermarks, pushedAt: PUSHED_AT })
    expect(second.pulled).toBe(1)
    expect(second.watermarks.snapshot).toBe('2026-10-10T00:00:00.000Z')
    expect(await idbGetAll(STORES.wordStates)).toHaveLength(4)
  })

  it('마지막 동기화 이후 바뀐 로컬 행만 보낸다', async () => {
    const server = memoryServer()
    await idbPut(STORES.documents, doc)
    await idbPut(STORES.wordStates, {
      ...wordState('ancien'),
      lastSeenAt: '2026-10-01T00:00:00.000Z',
    })

    const first = await sync(server)
    expect(first.pushed).toBe(1)

    await idbPut(STORES.wordStates, {
      ...wordState('nouveau'),
      lastSeenAt: '2026-10-21T00:00:00.000Z',
    })

    const second = await sync(server, { since: first.watermarks, pushedAt: PUSHED_AT })
    expect(second.pushed).toBe(1)
    expect(server.count('word_states')).toBe(2)
  })

  it('폴더 이동은 updatedAt 이 그대로여도 보낸다', async () => {
    const server = memoryServer()
    await idbPut(STORES.folders, {
      id: 'folder-1',
      name: 'Folder',
      parentId: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    })
    await idbPut(STORES.documents, doc)

    const first = await sync(server)
    expect(server.count('documents')).toBe(1)

    // moveToFolder 와 같은 모양 — updatedAt 은 그대로, folderUpdatedAt 만 새로 찍힌다
    await idbPut(STORES.documents, {
      ...doc,
      folderId: 'folder-1',
      folderUpdatedAt: '2026-10-21T00:00:00.000Z',
    })

    await sync(server, { since: first.watermarks, pushedAt: PUSHED_AT })

    const rows = server.rows('documents')
    expect(rows[0]?.folder_id).toBe('folder-1')
  })

  it('바뀐 문서의 등장 기록만 다시 받는다', async () => {
    const server = memoryServer()
    server.setSnapshot('2026-10-05T00:00:00.000Z')
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
      server_updated_at: '2026-10-05T00:00:00+00:00',
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
    // 현재 규칙으로 다시 계산하지 않은 문서 — 서버 기록이 이긴다
    await idbPut(STORES.documentMeta, { documentId: doc.id, lemmaVersion: -1 })
    await idbPut(STORES.wordOccurrences, {
      documentId: doc.id,
      languageCode: 'fr',
      lemma: 'chat',
      surfaces: ['chat'],
      count: 1,
      recordedAt: 1,
      charStart: 0,
      charEnd: 4,
      sentence: '옛 문장',
      documentTitle: doc.title,
    })

    const first = await sync(server)
    expect(first.watermarks.snapshot).toBe('2026-10-05T00:00:00.000Z')

    // 다른 기기에서 문서의 등장 기록이 바뀌었다
    const remoteDoc = server.rows('documents')[0]
    if (!remoteDoc) throw new Error('문서가 없다')
    remoteDoc.server_updated_at = '2026-10-10T00:00:00+00:00'
    const remoteOccurrence = server.rows('word_occurrences')[0]
    if (!remoteOccurrence) throw new Error('등장 기록이 없다')
    remoteOccurrence.sentence = '새 문장'

    server.setSnapshot('2026-10-10T00:00:00.000Z')
    const second = await sync(server, { since: first.watermarks, pushedAt: PUSHED_AT })
    expect(second.pushed).toBe(0)

    const local = await idbGetAll<{ documentId: string; lemma: string; sentence: string }>(
      STORES.wordOccurrences,
    )
    expect(local.find((row) => row.documentId === doc.id)?.sentence).toBe('새 문장')
  })
})
