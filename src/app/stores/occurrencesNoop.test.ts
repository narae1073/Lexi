import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import { useOccurrencesStore, type WordOccurrence } from './occurrences'
import { sameOccurrenceRecords } from '../../lib/sync/occurrenceNoop'
import { LEMMA_VERSION } from '../../features/reader/surfaceLemma'
import {
  STORES,
  idbGet,
  idbGetAllByIndex,
  idbPut,
  readLocalSyncMeta,
} from '../../lib/storage/localDb'
import type { Document } from '../../types'

/** Per-document bookkeeping row (`documentMeta`), not the reserved sync-meta record. */
type DocumentMetaRow = {
  documentId: string
  lemmaVersion: number
  segmenter?: string
  occurrencesUpdatedAt?: string
}

/** A fixed stamp written before a reload — it must survive an unchanged recomputation. */
const STAMP = '2026-01-02T00:00:00.000Z'

const doc = (over: Partial<Document> = {}): Document => ({
  id: 'doc-1',
  title: 'Doc',
  languageCode: 'fr',
  rawText: 'Le chat dort.',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

const record = (documentId: string, over: Partial<WordOccurrence> = {}): WordOccurrence => ({
  documentId,
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

const occurrencesOf = (documentId: string) =>
  idbGetAllByIndex<WordOccurrence>(STORES.wordOccurrences, 'documentId', documentId)

const metaOf = (documentId: string) =>
  idbGet<DocumentMetaRow>(STORES.documentMeta, documentId)

/** Record a cell so a rewrite is detectable — replacing rows drops these values. */
const withoutRecordedAt = (rows: WordOccurrence[]) =>
  rows.map((row) => ({ ...row, recordedAt: 0 }))

/** A rewrite drops this marker — `replaceOccurrences` deletes every row first. */
const markRows = async (rows: WordOccurrence[]) => {
  for (const row of rows) await idbPut(STORES.wordOccurrences, { ...row, recordedAt: 1 })
}

/** Everything sync would use to decide this device has unpushed work. */
const syncBookkeeping = async () => {
  const meta = await readLocalSyncMeta()
  return {
    revision: meta?.revision ?? 0,
    pendingByStore: meta?.pendingByStore ?? {},
    dirty: meta?.dirty ?? {},
  }
}

beforeEach(() => {
  useOccurrencesStore.setState({ recorded: {} })
})

describe('occurrence recomputation is no-op-free', () => {
  it('leaves rows and the per-document stamp untouched when the document is unchanged', async () => {
    const unchanged = doc()
    await useOccurrencesStore.getState().recordDocument(unchanged)

    const first = await occurrencesOf('doc-1')
    expect(first.length).toBeGreaterThan(0)
    await markRows(first)
    const before = await occurrencesOf('doc-1')

    // An earlier computation left a stamp; a reload must not move it.
    const stored = await metaOf('doc-1')
    expect(stored?.lemmaVersion).toBe(LEMMA_VERSION)
    await idbPut(STORES.documentMeta, { ...stored, occurrencesUpdatedAt: STAMP })
    const metaBefore = await metaOf('doc-1')
    const bookkeepingBefore = await syncBookkeeping()

    // Reload: the in-memory memory is empty, IndexedDB still has the last computation.
    useOccurrencesStore.setState({ recorded: {} })
    await useOccurrencesStore.getState().recordDocument(unchanged)

    const after = await occurrencesOf('doc-1')
    expect(withoutRecordedAt(after)).toEqual(withoutRecordedAt(before))
    expect(after.map((row) => row.recordedAt)).toEqual(before.map((row) => row.recordedAt))
    expect(await metaOf('doc-1')).toEqual(metaBefore)
    expect(await syncBookkeeping()).toEqual(bookkeepingBefore)
  })

  it('keeps the previous occurrencesUpdatedAt when the rule version is old but the output is identical', async () => {
    const unchanged = doc({ id: 'doc-2' })
    await useOccurrencesStore.getState().recordDocument(unchanged)

    const first = await occurrencesOf('doc-2')
    await markRows(first)
    const before = await occurrencesOf('doc-2')

    // Computed under an older rule; the stamp records a previous real write.
    await idbPut(STORES.documentMeta, {
      documentId: 'doc-2',
      lemmaVersion: LEMMA_VERSION - 1,
      occurrencesUpdatedAt: STAMP,
    })
    const bookkeepingBefore = await syncBookkeeping()

    useOccurrencesStore.setState({ recorded: {} })
    await useOccurrencesStore.getState().recordDocument(unchanged)

    const after = await occurrencesOf('doc-2')
    expect(withoutRecordedAt(after)).toEqual(withoutRecordedAt(before))
    expect(after.map((row) => row.recordedAt)).toEqual(before.map((row) => row.recordedAt))

    // The rule version is refreshed, but the old stamp stays: no rewrite, no push.
    const meta = await metaOf('doc-2')
    expect(meta?.lemmaVersion).toBe(LEMMA_VERSION)
    expect(meta?.occurrencesUpdatedAt).toBe(STAMP)
    expect(await syncBookkeeping()).toEqual(bookkeepingBefore)
  })

  it('writes nothing for an unchanged wordless document', async () => {
    const wordless = doc({ id: 'doc-3', rawText: '123 456' })
    await useOccurrencesStore.getState().recordDocument(wordless)

    expect(await occurrencesOf('doc-3')).toEqual([])
    const metaAfterFirst = await metaOf('doc-3')
    // Nothing was computed, so there is nothing to push.
    expect(metaAfterFirst?.occurrencesUpdatedAt).toBeUndefined()
    const bookkeepingBefore = await syncBookkeeping()

    useOccurrencesStore.setState({ recorded: {} })
    await useOccurrencesStore.getState().recordDocument(wordless)

    expect(await occurrencesOf('doc-3')).toEqual([])
    expect(await metaOf('doc-3')).toEqual(metaAfterFirst)
    expect(await syncBookkeeping()).toEqual(bookkeepingBefore)
  })

  it('clears old rows once when a document becomes wordless', async () => {
    await idbPut(STORES.wordOccurrences, record('doc-4'))
    await idbPut(STORES.documentMeta, {
      documentId: 'doc-4',
      lemmaVersion: LEMMA_VERSION,
      segmenter: 'intl',
      occurrencesUpdatedAt: STAMP,
    })
    const bookkeepingBefore = await syncBookkeeping()

    const wordless = doc({ id: 'doc-4', rawText: '123 456' })
    await useOccurrencesStore.getState().recordDocument(wordless)

    // The genuine transition goes through the normal write path so the server
    // can be told once.
    expect(await occurrencesOf('doc-4')).toEqual([])
    const afterClear = await syncBookkeeping()
    expect(afterClear.revision).toBeGreaterThan(bookkeepingBefore.revision)
    expect(afterClear.dirty.wordOccurrences?.['doc-4']).toBe(afterClear.revision)
    expect(afterClear.pendingByStore.wordOccurrences ?? 0).toBeGreaterThanOrEqual(1)
    const stampAfterClear = (await metaOf('doc-4'))?.occurrencesUpdatedAt
    expect(stampAfterClear).toBeDefined()
    expect(stampAfterClear).not.toBe(STAMP)

    // The next open finds empty rows and must not clear (or push) again.
    useOccurrencesStore.setState({ recorded: {} })
    await useOccurrencesStore.getState().recordDocument(wordless)
    expect(await syncBookkeeping()).toEqual(afterClear)
  })

  it('still replaces rows when the document content actually changed', async () => {
    const original = doc({ id: 'doc-5' })
    await useOccurrencesStore.getState().recordDocument(original)
    const before = await occurrencesOf('doc-5')

    useOccurrencesStore.setState({ recorded: {} })
    await useOccurrencesStore.getState().recordDocument({
      ...original,
      rawText: 'Le chien dort.',
    })

    const after = await occurrencesOf('doc-5')
    expect(after.map((row) => row.lemma).sort()).not.toEqual(before.map((row) => row.lemma).sort())
    expect(after.map((row) => row.lemma)).toContain('chien')
  })

  it('does not rewrite rows when only the document title changed', async () => {
    const original = doc({ id: 'doc-6' })
    await useOccurrencesStore.getState().recordDocument(original)

    const first = await occurrencesOf('doc-6')
    await markRows(first)
    const before = await occurrencesOf('doc-6')
    const bookkeepingBefore = await syncBookkeeping()

    useOccurrencesStore.setState({ recorded: {} })
    await useOccurrencesStore.getState().recordDocument({ ...original, title: 'Renamed' })

    const after = await occurrencesOf('doc-6')
    expect(withoutRecordedAt(after)).toEqual(withoutRecordedAt(before))
    expect(after.map((row) => row.recordedAt)).toEqual(before.map((row) => row.recordedAt))
    expect(await syncBookkeeping()).toEqual(bookkeepingBefore)
  })
})

describe('sameOccurrenceRecords', () => {
  const occurrence = (over: Partial<WordOccurrence> = {}): WordOccurrence => ({
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
    const a = [occurrence({ lemma: 'dort', charStart: 8, charEnd: 12 }), occurrence()]
    const b = [occurrence(), occurrence({ lemma: 'dort', charStart: 8, charEnd: 12 })]
    expect(sameOccurrenceRecords(a, b)).toBe(true)
  })

  it('ignores recordedAt and documentTitle', () => {
    expect(
      sameOccurrenceRecords(
        [occurrence({ recordedAt: 1, documentTitle: 'Old' })],
        [occurrence({ recordedAt: 99, documentTitle: 'New' })],
      ),
    ).toBe(true)
  })

  it('ignores surface order', () => {
    expect(
      sameOccurrenceRecords(
        [occurrence({ surfaces: ['chat', 'chats'] })],
        [occurrence({ surfaces: ['chats', 'chat'] })],
      ),
    ).toBe(true)
  })

  it('detects a changed count, range or sentence', () => {
    expect(sameOccurrenceRecords([occurrence()], [occurrence({ count: 2 })])).toBe(false)
    expect(sameOccurrenceRecords([occurrence()], [occurrence({ charEnd: 5 })])).toBe(false)
    expect(sameOccurrenceRecords([occurrence()], [occurrence({ sentence: 'Other.' })])).toBe(false)
  })

  it('detects a different document, language, lemma or surface', () => {
    expect(sameOccurrenceRecords([occurrence()], [occurrence({ documentId: 'doc-2' })])).toBe(false)
    expect(sameOccurrenceRecords([occurrence()], [occurrence({ languageCode: 'de' })])).toBe(false)
    expect(sameOccurrenceRecords([occurrence()], [occurrence({ lemma: 'chien' })])).toBe(false)
    expect(sameOccurrenceRecords([occurrence()], [occurrence({ surfaces: ['chats'] })])).toBe(false)
  })

  it('detects a missing or extra row', () => {
    expect(sameOccurrenceRecords([occurrence()], [])).toBe(false)
    expect(sameOccurrenceRecords([], [occurrence()])).toBe(false)
    expect(sameOccurrenceRecords([], [])).toBe(true)
  })
})
