import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import { useOccurrencesStore, type WordOccurrence } from './occurrences'
import { sameOccurrenceRecords } from '../../lib/sync/occurrenceNoop'
import {
  STORES,
  idbGetAllByIndex,
  idbPut,
  readLocalRevision,
  readLocalSyncMeta,
} from '../../lib/storage/localDb'
import type { Document } from '../../types'

const doc = (over: Partial<Document> = {}): Document => ({
  id: 'doc-1',
  title: 'Doc',
  languageCode: 'fr',
  rawText: 'Le chat dort.',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

const occurrencesOf = (documentId: string) =>
  idbGetAllByIndex<WordOccurrence>(STORES.wordOccurrences, 'documentId', documentId)

/** 기록 시각은 비교에서 뺀다 — 다시 쓰면 값이 달라지는지는 따로 본다 */
const withoutRecordedAt = (rows: WordOccurrence[]) =>
  rows.map((row) => ({ ...row, recordedAt: 0 }))

/** 다시 쓰면 사라지는 표시 — `replaceOccurrences` 는 행을 모두 지우고 새로 넣는다 */
const markRows = async (rows: WordOccurrence[]) => {
  for (const row of rows) await idbPut(STORES.wordOccurrences, { ...row, recordedAt: 1 })
}

beforeEach(() => {
  useOccurrencesStore.setState({ recorded: {} })
})

describe('occurrence recomputation is no-op-free', () => {
  it('does not replace rows when the recomputed document is unchanged', async () => {
    const unchanged = doc()
    await useOccurrencesStore.getState().recordDocument(unchanged)

    const first = await occurrencesOf('doc-1')
    expect(first.length).toBeGreaterThan(0)
    await markRows(first)
    const before = await occurrencesOf('doc-1')
    const revisionBefore = await readLocalRevision()
    const metaBefore = await readLocalSyncMeta()

    // 새로고침: 기억은 비었지만 IndexedDB 에는 지난 계산이 그대로 있다
    useOccurrencesStore.setState({ recorded: {} })
    await useOccurrencesStore.getState().recordDocument(unchanged)

    const after = await occurrencesOf('doc-1')
    expect(withoutRecordedAt(after)).toEqual(withoutRecordedAt(before))
    // no-op 이면 기록 시각도 새로 찍지 않는다
    expect(after.map((row) => row.recordedAt)).toEqual(before.map(() => 1))
    // 행을 다시 쓰지 않았으므로 동기화가 볼 변경도 없다
    expect(await readLocalRevision()).toBe(revisionBefore)
    const metaAfter = await readLocalSyncMeta()
    expect(metaAfter?.pendingByStore).toEqual(metaBefore?.pendingByStore)
    expect(metaAfter?.dirty).toEqual(metaBefore?.dirty)
  })

  it('does not rewrite rows when only the document title changed', async () => {
    const original = doc({ id: 'doc-2' })
    await useOccurrencesStore.getState().recordDocument(original)

    const first = await occurrencesOf('doc-2')
    expect(first.length).toBeGreaterThan(0)
    await markRows(first)
    const before = await occurrencesOf('doc-2')
    const revisionBefore = await readLocalRevision()

    useOccurrencesStore.setState({ recorded: {} })
    await useOccurrencesStore.getState().recordDocument({ ...original, title: 'Renamed' })

    const after = await occurrencesOf('doc-2')
    expect(withoutRecordedAt(after)).toEqual(withoutRecordedAt(before))
    expect(after.map((row) => row.recordedAt)).toEqual(before.map(() => 1))
    expect(await readLocalRevision()).toBe(revisionBefore)
  })

  it('still replaces rows when the document content actually changed', async () => {
    const original = doc({ id: 'doc-3' })
    await useOccurrencesStore.getState().recordDocument(original)
    const before = await occurrencesOf('doc-3')

    useOccurrencesStore.setState({ recorded: {} })
    await useOccurrencesStore.getState().recordDocument({
      ...original,
      rawText: 'Le chien dort.',
    })

    const after = await occurrencesOf('doc-3')
    expect(after.map((row) => row.lemma).sort()).not.toEqual(before.map((row) => row.lemma).sort())
    expect(after.map((row) => row.lemma)).toContain('chien')
  })
})

describe('sameOccurrenceRecords', () => {
  const record = (over: Partial<WordOccurrence> = {}): WordOccurrence => ({
    documentId: 'doc-1',
    languageCode: 'fr',
    lemma: 'chat',
    surfaces: ['chat'],
    count: 1,
    recordedAt: 1,
    charStart: 0,
    charEnd: 4,
    sentence: 'Le chat dort.',
    documentTitle: 'Doc',
    ...over,
  })

  it('treats rows in a different order as the same content', () => {
    const a = [record({ lemma: 'dort', charStart: 8, charEnd: 12 }), record()]
    const b = [record(), record({ lemma: 'dort', charStart: 8, charEnd: 12 })]
    expect(sameOccurrenceRecords(a, b)).toBe(true)
  })

  it('ignores recordedAt and documentTitle', () => {
    expect(
      sameOccurrenceRecords(
        [record({ recordedAt: 1, documentTitle: 'Old' })],
        [record({ recordedAt: 99, documentTitle: 'New' })],
      ),
    ).toBe(true)
  })

  it('ignores surface order', () => {
    expect(
      sameOccurrenceRecords([record({ surfaces: ['chat', 'chats'] })], [record({ surfaces: ['chats', 'chat'] })]),
    ).toBe(true)
  })

  it('detects a changed count, range or sentence', () => {
    expect(sameOccurrenceRecords([record()], [record({ count: 2 })])).toBe(false)
    expect(sameOccurrenceRecords([record()], [record({ charEnd: 5 })])).toBe(false)
    expect(sameOccurrenceRecords([record()], [record({ sentence: 'Other.' })])).toBe(false)
  })

  it('detects a different document, language, lemma or surface', () => {
    expect(sameOccurrenceRecords([record()], [record({ documentId: 'doc-2' })])).toBe(false)
    expect(sameOccurrenceRecords([record()], [record({ languageCode: 'de' })])).toBe(false)
    expect(sameOccurrenceRecords([record()], [record({ lemma: 'chien' })])).toBe(false)
    expect(sameOccurrenceRecords([record()], [record({ surfaces: ['chats'] })])).toBe(false)
  })

  it('detects a missing or extra row', () => {
    expect(sameOccurrenceRecords([record()], [])).toBe(false)
    expect(sameOccurrenceRecords([], [record()])).toBe(false)
    expect(sameOccurrenceRecords([], [])).toBe(true)
  })
})
