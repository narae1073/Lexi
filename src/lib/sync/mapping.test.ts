import { describe, expect, it } from 'vitest'

import type { WordOccurrence } from '../../app/stores/occurrences'
import type { Document, Folder } from '../../types'
import {
  documentFromRow,
  documentTombstoneFromRow,
  documentTombstoneToRow,
  documentToRow,
  folderFromRow,
  folderToRow,
  occurrenceFromRows,
  groupOccurrences,
  occurrenceToRows,
  wordStateFromRow,
  wordStateToRow,
  type DocumentRow,
  type DocumentTombstoneRow,
  type FolderRow,
} from './mapping'
import type { WordStateRow } from './mapping'

const USER = 'user-1'
const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-02T00:00:00.000Z'
const T2 = '2026-01-03T00:00:00.000Z'

const doc: Document = {
  id: 'doc-1',
  title: 'My text',
  languageCode: 'en',
  rawText: 'Hello world',
  createdAt: T0,
  updatedAt: T1,
  deletedAt: null,
  folderId: null,
  /** 폴더로 옮긴 적 없는 문서 — 인장은 문서를 연 시각이 기본값이다 */
  folderUpdatedAt: T1,
}

describe('word_state 매핑', () => {
  it('양방향으로 값이 보존된다', () => {
    const record = {
      languageCode: 'en',
      lemma: 'apple',
      status: 'known' as const,
      seenCount: 3,
      firstSeenAt: T0,
      lastSeenAt: T1,
      favorite: true,
      favoriteUpdatedAt: T1,
      starAngle: 12,
      starColor: '#ef4444',
      knownPresses: 2,
      unsurePresses: 1,
      unknownPresses: 0,
      note: 'apple = 사과 (기억)',
      noteUpdatedAt: T2,
    }
    // 보낼 때는 자동 채번 열을 싣지 않는다 — upsert payload 에 id 가 들어가면
    // 갱신되는 행의 id 가 그 값으로 덮인다
    const sent = wordStateToRow(USER, record)
    expect(sent).not.toHaveProperty('id')
    // 서버가 채운 행을 되읽었을 때 원래 값과 같아야 한다
    const row = { ...sent, id: 'generated', status: sent.status ?? 'unsure' } as WordStateRow
    expect(wordStateFromRow(row)).toEqual(record)
  })

  it('서버 열 이름에 맞춘다', () => {
    const row = wordStateToRow(USER, {
      languageCode: 'ko',
      lemma: '사과',
      status: 'unsure',
      seenCount: 1,
      firstSeenAt: T0,
      lastSeenAt: T0,
      favorite: false,
      favoriteUpdatedAt: T0,
      starAngle: 0,
      starColor: '#eab308',
      knownPresses: 0,
      unsurePresses: 0,
      unknownPresses: 0,
    })
    expect(row).toMatchObject({
      user_id: USER,
      language_code: 'ko',
      lemma: '사과',
      status: 'unsure',
      seen_count: 1,
      // 메모를 적지 않은 행은 null 로 보낸다 — 서버의 '없음'
      note: null,
      note_updated_at: null,
    })
  })

  it('메모가 없는 행은 undefined 로 읽는다 — 빈 메모와 구분한다', () => {
    const sent = wordStateToRow(USER, {
      languageCode: 'en',
      lemma: 'apple',
      status: 'known',
      seenCount: 1,
      firstSeenAt: T0,
      lastSeenAt: T1,
      favorite: false,
      favoriteUpdatedAt: T0,
      starAngle: 0,
      starColor: '#eab308',
      knownPresses: 0,
      unsurePresses: 0,
      unknownPresses: 0,
    })
    const row = { ...sent, id: 'generated' } as WordStateRow
    expect(wordStateFromRow(row).note).toBeUndefined()
    expect(wordStateFromRow(row).noteUpdatedAt).toBeUndefined()
  })

  it('상태를 비운 행은 null 로 보내고 undefined 로 읽는다', () => {
    const sent = wordStateToRow(USER, {
      languageCode: 'en',
      lemma: 'apple',
      seenCount: 1,
      firstSeenAt: T0,
      lastSeenAt: T1,
      favorite: true,
      favoriteUpdatedAt: T2,
      starAngle: 0,
      starColor: '#eab308',
      knownPresses: 2,
      unsurePresses: 0,
      unknownPresses: 0,
    })
    const row = { ...sent, id: 'generated' } as WordStateRow
    expect(row.status).toBeNull()
    expect(wordStateFromRow(row).status).toBeUndefined()
    // 행 자체는 남아 기록을 보존한다
    expect(wordStateFromRow(row).favorite).toBe(true)
    expect(wordStateFromRow(row).knownPresses).toBe(2)
  })

  it('세 가지 상태를 모두 그대로 옮긴다', () => {
    for (const status of ['known', 'unsure', 'unknown'] as const) {
      const row = wordStateToRow(USER, {
        languageCode: 'en',
        lemma: 'x',
        status,
        seenCount: 1,
        firstSeenAt: T0,
        lastSeenAt: T0,
        favorite: false,
        favoriteUpdatedAt: T0,
        starAngle: 0,
        starColor: '#eab308',
        knownPresses: 0,
        unsurePresses: 0,
        unknownPresses: 0,
      })
      expect(wordStateFromRow(row as WordStateRow).status).toBe(status)
    }
  })
})

describe('documents 매핑', () => {
  it('양방향으로 값이 보존된다', () => {
    expect(documentFromRow(documentToRow(USER, doc) as DocumentRow)).toEqual(doc)
  })

  it('사용자 id 를 함께 싣는다', () => {
    expect(documentToRow(USER, doc).user_id).toBe(USER)
  })

  /**
   * 살아 있는 문서와 버려진 문서가 모두 왕복을 보존해야 한다.
   *
   * 버린 시각이 왕복에서 사라지면 다른 기기에서 되살린 문서가 살아 있는 것으로 보인다.
   */
  it('버려진 문서도 버린 시각을 보존한다', () => {
    const trashed = { ...doc, deletedAt: '2026-03-01T00:00:00.000Z' }
    expect(documentToRow(USER, trashed).deleted_at).toBe('2026-03-01T00:00:00.000Z')
    expect(documentFromRow(documentToRow(USER, trashed) as DocumentRow)).toEqual(trashed)
  })

  it('살아 있는 문서는 deleted_at 이 NULL 이다', () => {
    expect(documentToRow(USER, { ...doc, deletedAt: undefined }).deleted_at).toBeNull()
  })

  /**
   * 폴더도 왕복을 보존해야 한다 — 옮긴 기록이 사라지면 다른 기기는
   * 문서가 폴더에 없는 것으로 보인다.
   */
  it('폴더에 놓인 문서도 폴더와 인장을 보존한다', () => {
    const moved = { ...doc, folderId: 'folder-1', folderUpdatedAt: T1 }
    const row = documentToRow(USER, moved)
    expect(row.folder_id).toBe('folder-1')
    expect(row.folder_updated_at).toBe(T1)
    expect(documentFromRow(row as DocumentRow)).toEqual(moved)
  })

  /** 폴더 기능 이전의 행에는 두 열이 모두 없다 (NULL) — 읽을 때 기본값을 채운다 */
  it('폴더 열이 없던 행도 읽는다 — 인장은 열람 시각이 기본값이다', () => {
    const legacyRow = {
      ...documentToRow(USER, doc),
      folder_id: null,
      folder_updated_at: null,
    } as DocumentRow
    const back = documentFromRow(legacyRow)
    expect(back.folderId).toBeNull()
    expect(back.folderUpdatedAt).toBe(doc.updatedAt)
  })

  /** 폴더 매핑 — 폴더 자체의 왕복이다 */
  it('폴더도 양방향으로 값이 보존된다', () => {
    const folder: Folder = {
      id: 'folder-1',
      name: 'Reading',
      parentId: null,
      createdAt: T0,
      updatedAt: T1,
      deletedAt: null,
    }
    // Insert 모양에는 자동 채번 열이 없어도, 이 표는 id 를 클라이언트가 찍는다 — 왕복에 필요하다
    const rowOf = (f: Folder): FolderRow => folderToRow(USER, f) as unknown as FolderRow
    expect(folderFromRow(rowOf(folder))).toEqual(folder)

    const child: Folder = { ...folder, id: 'folder-2', parentId: 'folder-1' }
    expect(folderFromRow(rowOf(child))).toEqual(child)

    const tombstoned: Folder = { ...folder, deletedAt: T1 }
    expect(rowOf(tombstoned).deleted_at).toBe(T1)
    expect(folderFromRow(rowOf(tombstoned))).toEqual(tombstoned)
  })
})

describe('word_occurrences 매핑', () => {
  const record: WordOccurrence = {
    documentId: 'doc-1',
    languageCode: 'en',
    lemma: 'us',
    surfaces: ['US', 'us'],
    count: 2,
    recordedAt: Date.parse(T1),
    charStart: 10,
    charEnd: 30,
    sentence: 'The US economy grew.',
    documentTitle: 'My text',
  }

  it('자동 채번 열을 싣지 않는다 — 서버가 채우게 둔다', () => {
    const rows = occurrenceToRows(USER, record)
    expect(rows.every((r) => !('id' in r))).toBe(true)
  })

  it('표기 하나당 한 줄로 펼친다 — 서버는 표기를 따로 담는다', () => {
    const rows = occurrenceToRows(USER, record)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.surface)).toEqual(['US', 'us'])
    expect(rows.every((r) => r.document_id === 'doc-1' && r.lemma === 'us')).toBe(true)
  })

  it('펼친 줄을 다시 모으면 로컬 모양이 된다', () => {
    const rows = occurrenceToRows(USER, record)
    const back = occurrenceFromRows(rows, doc)
    expect(back).toMatchObject({
      documentId: 'doc-1',
      languageCode: 'en',
      lemma: 'us',
      surfaces: ['US', 'us'],
      sentence: 'The US economy grew.',
      documentTitle: 'My text',
    })
  })

  it('순서가 뒤섞여 있어도 문서 순으로 모은다', () => {
    const rows = occurrenceToRows(USER, record).reverse()
    expect(occurrenceFromRows(rows, doc).charStart).toBe(10)
  })

  /**
   * 회귀: 문서만으로 묶으면 문서 안의 모든 단어가 한 레코드로 뭉개진다.
   * 실제로 새 기기에서 단어장이 "1 words" 로 보이던 원인이었다.
   */
  it('문서만으로 묶지 않는다 — 같은 문서의 다른 단어가 합쳐지면 안 된다', () => {
    const rows = [
      ...occurrenceToRows(USER, record),
      ...occurrenceToRows(USER, { ...record, lemma: ' luna', surfaces: ['luna'] }),
      ...occurrenceToRows(USER, { ...record, lemma: ' tejado', surfaces: ['tejado'] }),
    ]
    const grouped = groupOccurrences(rows)
    expect(grouped).toHaveLength(3)
    expect(grouped.map((g) => g.lemma).sort()).toEqual([' luna', ' tejado', 'us'])
  })

  it('같은 단어의 여러 표기는 한 그룹으로 묶인다', () => {
    const grouped = groupOccurrences(occurrenceToRows(USER, record))
    expect(grouped).toHaveLength(1)
    expect(grouped[0].rows).toHaveLength(2)
    expect(grouped[0].rows.map((r) => r.surface)).toEqual(['US', 'us'])
  })

  it('문서가 다르면 같은 단어도 따로 묶인다', () => {
    const rows = [
      ...occurrenceToRows(USER, record),
      ...occurrenceToRows(USER, { ...record, documentId: 'doc-2' }),
    ]
    const grouped = groupOccurrences(rows)
    expect(grouped).toHaveLength(2)
    expect(grouped.map((g) => g.documentId).sort()).toEqual(['doc-1', 'doc-2'])
  })

  it('라운드트립 후에도 단어마다 한 건씩 남는다', () => {
    // 문서에 단어 3개가 있다고 하자
    const words = ['gato', 'luna', 'tejado'].map((lemma) => ({ ...record, lemma, surfaces: [lemma] }))
    const rows = words.flatMap((w) => occurrenceToRows(USER, w))
    const pulled = groupOccurrences(rows).map((g) => occurrenceFromRows(g.rows, doc))
    expect(pulled).toHaveLength(3)
    expect(pulled.map((o) => o.lemma).sort()).toEqual(['gato', 'luna', 'tejado'])
    expect(pulled.map((o) => o.surfaces[0]).sort()).toEqual(['gato', 'luna', 'tejado'])
  })

  it('표기가 하나뿐이면 한 줄이다', () => {
    expect(occurrenceToRows(USER, { ...record, surfaces: ['us'] })).toHaveLength(1)
  })

  it('등장 횟수를 함께 보낸다', () => {
    // 없으면 새 기기에서 ×N 이 표기 수(대부분 1)로 보여 실제와 어긋난다
    const rows = occurrenceToRows(USER, { ...record, count: 7 })
    expect(rows.map((r) => r.occurrences_count)).toEqual([7, 7])
  })

  it('라운드트립 후에도 등장 횟수가 보존된다', () => {
    const rows = occurrenceToRows(USER, { ...record, count: 4 })
    expect(occurrenceFromRows(rows, doc).count).toBe(4)
  })

  it('옛 행에 횟수 열이 없어도 1 로 읽는다 — 마이그레이션 이전 데이터', () => {
    const { occurrences_count: _dropped, ...legacy } = occurrenceToRows(USER, record)[0]
    expect(occurrenceFromRows([legacy], doc).count).toBe(1)
  })
})

describe('document_tombstones 매핑', () => {
  it('양방향으로 값이 보존된다', () => {
    const tombstone = { documentId: 'doc-1', purgedAt: T1 }
    const row = documentTombstoneToRow(USER, tombstone) as DocumentTombstoneRow
    expect(documentTombstoneFromRow(row)).toEqual(tombstone)
  })
})
