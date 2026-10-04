import { describe, expect, it } from 'vitest'

import type { WordOccurrence } from '../../app/stores/occurrences'
import type { Document } from '../../types'
import {
  documentFromRow,
  documentToRow,
  groupOccurrencesByDocument,
  occurrenceFromRows,
  occurrenceToRows,
  wordStateFromRow,
  wordStateToRow,
} from './mapping'
import type { WordStateRow } from './mapping'

const USER = 'user-1'
const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-02T00:00:00.000Z'

const doc: Document = {
  id: 'doc-1',
  title: 'My text',
  languageCode: 'en',
  rawText: 'Hello world',
  createdAt: T0,
  updatedAt: T1,
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
    })
    expect(row).toMatchObject({
      user_id: USER,
      language_code: 'ko',
      lemma: '사과',
      status: 'unsure',
      seen_count: 1,
    })
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
      })
      expect(wordStateFromRow(row as WordStateRow).status).toBe(status)
    }
  })
})

describe('documents 매핑', () => {
  it('양방향으로 값이 보존된다', () => {
    expect(documentFromRow(documentToRow(USER, doc))).toEqual(doc)
  })

  it('사용자 id 를 함께 싣는다', () => {
    expect(documentToRow(USER, doc).user_id).toBe(USER)
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

  it('문서 id 로 묶는다', () => {
    const other = occurrenceToRows(USER, { ...record, documentId: 'doc-2' })
    const grouped = groupOccurrencesByDocument([...occurrenceToRows(USER, record), ...other])
    expect(grouped.get('doc-1')).toHaveLength(2)
    expect(grouped.get('doc-2')).toHaveLength(2)
  })

  it('표기가 하나뿐이면 한 줄이다', () => {
    expect(occurrenceToRows(USER, { ...record, surfaces: ['us'] })).toHaveLength(1)
  })
})
