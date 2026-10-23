import 'fake-indexeddb/auto'

import { readFileSync } from 'node:fs'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { WordOccurrence } from '../../app/stores/occurrences'
import { useOccurrencesStore } from '../../app/stores/occurrences'
import { useDocumentsStore } from '../../app/stores/documents'
import { useWordStatesStore } from '../../app/stores/wordStates'
import { useWordbookStore } from '../../app/stores/wordbook'
import {
  STORES,
  deleteLocalDatabase,
  idbDeleteByIndex,
  idbPut,
  replaceOccurrences,
} from '../../lib/storage/localDb'
import { readWordbookEntries } from '../../lib/storage/wordbookEntries'
import type { Document, WordState, WordStatus } from '../../types'
import { buildWordbook } from './buildWordbook'
import type { WordbookEntry } from './buildWordbook'
import {
  buildLocalProjection,
  createLocalProjectionProducer,
  disposeLocalProjectionWorker,
  onLocalProjectionChange,
  searchLocalProjection,
  type LocalProjectionBuild,
  type LocalProjectionChange,
  type LocalProjectionRequest,
  type LocalWordState,
} from './localProjection'
import {
  projectionEntriesToWordbook,
  type ProjectionEntry,
  type ProjectionWordbookEntry,
} from './wordbookProjection'
import {
  createWordbookWorkerClient,
  createWordbookWorkerState,
  handleWordbookRequest,
  type WordbookWorkerRequest,
  type WordbookWorkerResponse,
  type WorkerLike,
} from './wordbookWorker'

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

const DOCUMENTS = [
  { id: 'd1', title: 'Doc One' },
  { id: 'd2', title: 'Doc Two' },
  { id: 'd3', title: 'Doc Three' },
]

function occurrence(over: Partial<WordOccurrence> & { lemma: string }): WordOccurrence {
  return {
    documentId: 'd1',
    languageCode: 'en',
    surfaces: [over.lemma],
    count: 1,
    recordedAt: 1000,
    charStart: 0,
    charEnd: over.lemma.length,
    sentence: `A ${over.lemma}.`,
    documentTitle: 'Doc One',
    ...over,
  }
}

function wordState(
  lemma: string,
  status?: WordStatus,
  over: Partial<WordState & { favoriteUpdatedAt: string }> = {},
): WordState & { favoriteUpdatedAt?: string } {
  return {
    lemma,
    languageCode: 'en',
    status,
    seenCount: 1,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-02-02T00:00:00.000Z',
    favorite: false,
    starAngle: 0,
    starColor: '#eab308',
    knownPresses: 0,
    unsurePresses: 0,
    unknownPresses: 0,
    ...over,
  }
}

/** The fields a user can see, without the extra id the projection keeps for progress. */
function visible(entry: WordbookEntry | ProjectionWordbookEntry) {
  return {
    lemma: entry.lemma,
    // Surfaces are a set (the occurrence no-op diff treats them that way); the
    // server sorts them while `buildWordbook` keeps encounter order, so the
    // account-parity test below compares the sorted set. Order itself is
    // asserted against a server-shaped fixture.
    surfaces: [...entry.surfaces].sort(),
    status: entry.status,
    favorite: entry.favorite,
    // An unstarred row has no visible star colour. The server (and therefore a
    // projection row) always stores its default; buildWordbook leaves it
    // undefined. Only a starred row can show a colour, so compare that.
    starColor: entry.favorite ? entry.starColor : undefined,
    sentence: entry.sentence,
    documentId: entry.documentId,
    documentTitle: entry.documentTitle,
    contexts: entry.contexts.map((context) => ({
      sentence: context.sentence,
      documentTitle: context.documentTitle,
    })),
    lastSeenAt: entry.lastSeenAt,
    knownPresses: entry.knownPresses,
    note: entry.note,
    count: entry.count,
    documentCount: entry.documentCount,
  }
}

const PARITY_OCCURRENCES: WordOccurrence[] = [
  occurrence({
    lemma: 'apple',
    documentId: 'd1',
    documentTitle: 'Doc One',
    count: 2,
    sentence: 'An apple is red.',
    recordedAt: 3000,
  }),
  occurrence({
    lemma: 'apple',
    documentId: 'd2',
    documentTitle: 'Doc Two',
    surfaces: ['Apple'],
    count: 1,
    sentence: 'Apple pie is sweet.',
    recordedAt: 2000,
  }),
  // Empty sentence: the row keeps its document, but the quiz gets no context.
  occurrence({
    lemma: 'dog',
    documentId: 'd2',
    documentTitle: 'Doc Two',
    count: 3,
    sentence: '',
    recordedAt: 1000,
  }),
  occurrence({
    lemma: 'fox',
    documentId: 'd3',
    documentTitle: 'Doc Three',
    sentence: 'A fox runs.',
    recordedAt: 4000,
  }),
  // No word state at all: every state field takes the server default.
  occurrence({
    lemma: 'bird',
    documentId: 'd1',
    documentTitle: 'Doc One',
    sentence: 'A bird sings.',
    recordedAt: 5000,
  }),
]

const PARITY_STATES: WordState[] = [
  wordState('apple', 'known', {
    favorite: true,
    starColor: '#ef4444',
    note: 'remember this',
    lastSeenAt: '2026-10-01T00:00:00.000Z',
    knownPresses: 4,
  }),
  wordState('fox', 'unsure'),
  wordState('dog', undefined, { lastSeenAt: '2026-01-01T00:00:00.000Z' }),
]

function stateMap(states: readonly (WordState & { favoriteUpdatedAt?: string })[]) {
  const byKey: Record<string, WordState> = {}
  for (const state of states) byKey[`${state.languageCode}::${state.lemma}`] = state
  return byKey
}

/**
 * A fake worker that runs the real protocol handler on a later task.
 *
 * The boundary is the same one production uses: the caller only posts a
 * message, and the handler runs somewhere else (a real worker thread in the
 * browser, a timer here). It also records the messages, so a test can prove no
 * extra rebuild crossed the boundary.
 */
class FakeWorker implements WorkerLike {
  messages: (WordbookWorkerRequest & { id?: number })[] = []
  onmessage: ((event: { data: WordbookWorkerResponse & { id?: number } }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  private readonly state = createWordbookWorkerState()

  postMessage(message: unknown): void {
    const request = message as WordbookWorkerRequest & { id?: number }
    this.messages.push(request)
    setTimeout(() => {
      const response = handleWordbookRequest(this.state, request)
      this.onmessage?.({ data: { ...response, id: request.id } })
    }, 0)
  }
}

function inlineWorker() {
  return createWordbookWorkerClient({ inline: true })
}

/**
 * A worker whose builds are resolved by the test.
 *
 * Lets a reset land while a build is in flight, which is exactly the account-
 * linking race the generation fence has to close.
 */
function deferredWorker() {
  const calls: LocalProjectionRequest[] = []
  const resolvers: ((build: LocalProjectionBuild) => void)[] = []
  const localClear = vi.fn(async () => {})
  return {
    calls,
    localClear,
    localRebuild(_languageCode: string, request: LocalProjectionRequest) {
      calls.push(request)
      return new Promise<LocalProjectionBuild>((resolve) => {
        resolvers.push(resolve)
      })
    },
    resolve(index: number, build: LocalProjectionBuild) {
      const resolve = resolvers[index]
      if (!resolve) throw new Error(`no pending build at ${index}`)
      resolve(build)
    },
  }
}

async function seedOccurrences(rows: readonly WordOccurrence[]): Promise<void> {
  for (const row of rows) await idbPut(STORES.wordOccurrences, row)
}

async function seedStates(states: readonly WordState[]): Promise<void> {
  for (const state of states) {
    await idbPut(STORES.wordStates, { ...state, surface: state.lemma })
  }
}

/* ------------------------------------------------------------------------- *
 * Pure builder parity
 * ------------------------------------------------------------------------- */

describe('buildLocalProjection parity with buildWordbook', () => {
  it('produces the same visible rows as the occurrence-built wordbook', () => {
    const expected = buildWordbook({
      languageCode: 'en',
      occurrences: PARITY_OCCURRENCES,
      byKey: stateMap(PARITY_STATES),
    })
      .map(visible)
      .sort((a, b) => a.lemma.localeCompare(b.lemma, 'en'))

    const actual = projectionEntriesToWordbook(
      buildLocalProjection(PARITY_OCCURRENCES, PARITY_STATES),
      {
        documents: DOCUMENTS,
        stateOf: (lemma) => stateMap(PARITY_STATES)[`en::${lemma}`],
      },
    )
      .map(visible)
      .sort((a, b) => a.lemma.localeCompare(b.lemma, 'en'))

    expect(actual).toEqual(expected)
  })

  it('orders contexts and surfaces exactly like the server projection', () => {
    // Occurrences arrive in a scrambled order. The server aggregates
    // `contexts order by document_id, sentence` and `surfaces order by surface`
    // (wordbook_refresh.sql), so the local row must not depend on input order
    // or recency. This fixture is written the way the server stores a row.
    const occurrences = [
      occurrence({ lemma: 'cat', documentId: 'b', sentence: 'Beta cat.', recordedAt: 9000 }),
      occurrence({ lemma: 'cat', documentId: 'a', surfaces: ['cat'], sentence: 'Alpha cat.', recordedAt: 1000 }),
      occurrence({ lemma: 'cat', documentId: 'b', surfaces: ['Cat'], sentence: 'Beta cat.', recordedAt: 9000 }),
    ]
    const serverShaped: ProjectionEntry[] = [
      {
        languageCode: 'en',
        lemma: 'cat',
        surfaces: ['Cat', 'cat'],
        contexts: [
          { documentId: 'a', sentence: 'Alpha cat.' },
          { documentId: 'b', sentence: 'Beta cat.' },
        ],
        occurrenceCount: 3,
        documentCount: 2,
        status: null,
        isFavorite: false,
        starAngle: 0,
        starColor: '#eab308',
        seenCount: 1,
        firstSeenAt: null,
        lastSeenAt: null,
        favoriteUpdatedAt: null,
        knownPresses: 0,
        unsurePresses: 0,
        unknownPresses: 0,
        note: null,
        noteUpdatedAt: null,
        serverUpdatedAt: null,
      },
    ]
    expect(buildLocalProjection(occurrences, [])).toEqual(serverShaped)
  })

  it('picks the example by server document order, not by recency', () => {
    // Account mode reads contexts[0] from the server row, which is ordered by
    // document id. Local-only must show the same document. (`buildWordbook`'s
    // occurrence list chose the most recent document; that is the legacy path,
    // and the projection deliberately replaced it.)
    const entries = projectionEntriesToWordbook(
      buildLocalProjection(
        [
          occurrence({ lemma: 'cat', documentId: 'old', sentence: 'Old cat.', recordedAt: 1000 }),
          occurrence({ lemma: 'cat', documentId: 'new', sentence: 'New cat.', recordedAt: 5000 }),
          occurrence({ lemma: 'cat', documentId: 'mid', sentence: 'Mid cat.', recordedAt: 3000 }),
        ],
        [],
      ),
      {
        documents: [
          { id: 'old', title: 'Old' },
          { id: 'mid', title: 'Mid' },
          { id: 'new', title: 'New' },
        ],
      },
    )
    expect(entries[0]).toMatchObject({
      sentence: 'Mid cat.',
      documentId: 'mid',
      documentTitle: 'Mid',
      count: 3,
      documentCount: 3,
    })
    // Every sentence is kept for the quiz, in the same order the server keeps.
    expect(entries[0].contexts.map((context) => context.sentence)).toEqual([
      'Mid cat.',
      'New cat.',
      'Old cat.',
    ])
  })

  it('uses a real sentence ordered by document when another document has none', () => {
    // The server never stores an empty sentence as a context, so the account
    // read model shows the first real one by document id. The local producer
    // keeps that rule, and still remembers that the word occurs in the
    // empty-sentence document (for its progress gauge).
    const entries = projectionEntriesToWordbook(
      buildLocalProjection(
        [
          occurrence({
            lemma: 'cat',
            documentId: 'd1',
            sentence: 'Old cat.',
            recordedAt: 1000,
          }),
          occurrence({ lemma: 'cat', documentId: 'd2', sentence: '', recordedAt: 5000 }),
        ],
        [],
      ),
      { documents: DOCUMENTS },
    )
    expect(entries[0]).toMatchObject({
      sentence: 'Old cat.',
      documentId: 'd1',
      documentTitle: 'Doc One',
      documentCount: 2,
    })
    expect(entries[0].contexts).toEqual([
      { sentence: 'Old cat.', documentTitle: 'Doc One', documentId: 'd1' },
    ])
    expect(entries[0].documentIds?.sort()).toEqual(['d1', 'd2'])
  })

  it('keeps a document whose only sentence is empty, without a quiz context', () => {    const entries = projectionEntriesToWordbook(
      buildLocalProjection(
        [
          occurrence({
            lemma: 'dog',
            documentId: 'd2',
            sentence: '',
            count: 3,
          }),
        ],
        [],
      ),
      { documents: DOCUMENTS },
    )
    expect(entries[0]).toMatchObject({
      sentence: '',
      documentId: 'd2',
      documentTitle: 'Doc Two',
      count: 3,
      documentCount: 1,
    })
    expect(entries[0].contexts).toEqual([])
  })

  it('sums counts over documents and counts each document once', () => {
    const entries = buildLocalProjection(
      [
        occurrence({ lemma: 'cat', documentId: 'd1', count: 2 }),
        occurrence({ lemma: 'cat', documentId: 'd2', count: 5 }),
        occurrence({ lemma: 'dog', documentId: 'd1', count: 1 }),
      ],
      [],
    )
    const cat = entries.find((entry) => entry.lemma === 'cat')
    expect(cat).toMatchObject({ occurrenceCount: 7, documentCount: 2 })
    expect(entries.map((entry) => entry.lemma)).toEqual(['cat', 'dog'])
  })

  it('never projects a word state without an occurrence', () => {
    const entries = buildLocalProjection(
      [occurrence({ lemma: 'cat' })],
      [wordState('cat', 'known'), wordState('ghost', 'known')],
    )
    expect(entries.map((entry) => entry.lemma)).toEqual(['cat'])
  })

  it('accepts the store-shaped record as well as an array', () => {
    const fromArray = buildLocalProjection([occurrence({ lemma: 'cat' })], [
      wordState('cat', 'known'),
    ])
    const fromRecord = buildLocalProjection([occurrence({ lemma: 'cat' })], {
      'en::cat': wordState('cat', 'known') as LocalWordState,
    })
    expect(fromRecord).toEqual(fromArray)
    expect(fromArray[0]).toMatchObject({ status: 'known' })
  })

  it('changes exactly one row when one state changes', () => {
    const before = buildLocalProjection(PARITY_OCCURRENCES, PARITY_STATES)
    const after = buildLocalProjection(PARITY_OCCURRENCES, [
      ...PARITY_STATES.filter((state) => state.lemma !== 'fox'),
      wordState('fox', 'known', { favorite: true, note: 'fixed' }),
    ])
    const changed = after.filter(
      (entry, index) => JSON.stringify(entry) !== JSON.stringify(before[index]),
    )
    expect(changed.map((entry) => entry.lemma)).toEqual(['fox'])
    expect(changed[0]).toMatchObject({ status: 'known', isFavorite: true, note: 'fixed' })
  })
})

/* ------------------------------------------------------------------------- *
 * Worker protocol
 * ------------------------------------------------------------------------- */

describe('local projection worker', () => {
  it('builds a full language and serves search from the local index', async () => {
    const worker = new FakeWorker()
    const client = createWordbookWorkerClient({ worker })

    const built = await client.localRebuild('en', {
      occurrences: PARITY_OCCURRENCES,
      wordStates: PARITY_STATES,
    })
    expect(built.full).toBe(true)
    expect(built.removed).toEqual([])
    expect(built.total).toBe(4)
    expect(built.entries.map((entry) => entry.lemma).sort()).toEqual([
      'apple',
      'bird',
      'dog',
      'fox',
    ])
    expect(await client.search('app', 'en')).toEqual(['apple'])
    expect(await client.search('appl', 'en')).toEqual(['apple'])
    client.terminate()
  })

  it('recomputes only the lemmas of a changed document', async () => {
    const worker = new FakeWorker()
    const client = createWordbookWorkerClient({ worker })
    await client.localRebuild('en', { occurrences: PARITY_OCCURRENCES })

    // d2 changes: apple's sentence is edited, dog disappears from it.
    const edited = occurrence({
      lemma: 'apple',
      documentId: 'd2',
      documentTitle: 'Doc Two',
      surfaces: ['Apple'],
      count: 1,
      sentence: 'Apple tart is sweet.',
      recordedAt: 2000,
    })
    const result = await client.localRebuild('en', {
      occurrences: [edited],
      documentIds: ['d2'],
    })

    expect(result.full).toBe(false)
    expect(result.entries.map((entry) => entry.lemma)).toEqual(['apple'])
    expect(result.removed).toEqual(['dog'])
    expect(result.total).toBe(3)
    const apple = result.entries[0]
    expect(apple.occurrenceCount).toBe(3)
    expect(apple.documentCount).toBe(2)
    expect(apple.contexts).toEqual([
      { documentId: 'd1', sentence: 'An apple is red.' },
      { documentId: 'd2', sentence: 'Apple tart is sweet.' },
    ])
    // The message crossed the boundary with just the one document.
    expect(worker.messages.at(-1)).toMatchObject({
      type: 'local-rebuild',
      documentIds: ['d2'],
    })
    client.terminate()
  })

  it('removes a purged document and keeps a shared lemma alive', async () => {
    const worker = new FakeWorker()
    const client = createWordbookWorkerClient({ worker })
    await client.localRebuild('en', { occurrences: PARITY_OCCURRENCES })

    const result = await client.localRebuild('en', {
      occurrences: [],
      removedDocumentIds: ['d2'],
    })

    // apple also occurs in d1, so it survives with d1's counts.
    expect(result.removed).toEqual(['dog'])
    const apple = result.entries.find((entry) => entry.lemma === 'apple')
    expect(apple).toMatchObject({ occurrenceCount: 2, documentCount: 1 })
    expect(apple?.contexts).toEqual([{ documentId: 'd1', sentence: 'An apple is red.' }])
    expect(result.total).toBe(3)
    client.terminate()
  })

  it('is a no-op when nothing about the document changed', async () => {
    const worker = new FakeWorker()
    const client = createWordbookWorkerClient({ worker })
    await client.localRebuild('en', { occurrences: PARITY_OCCURRENCES })

    const same = PARITY_OCCURRENCES.filter((row) => row.documentId === 'd2')
    const result = await client.localRebuild('en', {
      occurrences: same,
      documentIds: ['d2'],
    })
    expect(result.entries).toEqual([])
    expect(result.removed).toEqual([])
    expect(result.total).toBe(4)
    client.terminate()
  })

  it('merges a state without returning a rebuild payload', async () => {
    const worker = new FakeWorker()
    const client = createWordbookWorkerClient({ worker })
    await client.localRebuild('en', { occurrences: PARITY_OCCURRENCES })

    const merged = await client.localRebuild('en', {
      occurrences: [],
      documentIds: [],
      wordStates: [wordState('apple', 'unsure')],
    })
    expect(merged.entries).toEqual([])
    expect(merged.removed).toEqual([])

    // A later document edit of a lemma projects the merged state, so the worker
    // does not write an older status back over the local row.
    const edited = PARITY_OCCURRENCES.filter((row) => row.documentId === 'd1').map((row) => ({
      ...row,
      sentence: `${row.sentence} Edited.`,
    }))
    const result = await client.localRebuild('en', {
      occurrences: edited,
      documentIds: ['d1'],
    })
    expect(result.entries.find((entry) => entry.lemma === 'apple')?.status).toBe('unsure')
    client.terminate()
  })

  it('builds a 200k-occurrence language in the worker without blocking the caller', async () => {
    const occurrences: WordOccurrence[] = []
    for (let lemmaIndex = 0; occurrences.length < 200_000; lemmaIndex += 1) {
      const lemma = `word-${String(lemmaIndex).padStart(6, '0')}`
      for (const documentId of [`d${lemmaIndex % 100}`, `d${(lemmaIndex + 50) % 100}`]) {
        occurrences.push({
          documentId,
          languageCode: 'en',
          lemma,
          surfaces: [lemma, `${lemma}s`],
          count: 1,
          recordedAt: 1000 + lemmaIndex,
          charStart: 0,
          charEnd: lemma.length,
          sentence: `A sentence with ${lemma}.`,
          documentTitle: `Document ${documentId}`,
        })
      }
    }
    expect(occurrences).toHaveLength(200_000)

    const worker = new FakeWorker()
    const client = createWordbookWorkerClient({ worker })
    let settled = false
    const started = performance.now()
    const building = client.localRebuild('en', { occurrences }).then((result) => {
      settled = true
      return result
    })
    // Only a postMessage happened in this turn — the build did not run inline.
    expect(settled).toBe(false)
    expect(worker.messages.map((message) => message.type)).toEqual(['local-rebuild'])

    const result: LocalProjectionBuild = await building
    const buildMs = performance.now() - started
    expect(settled).toBe(true)
    expect(result.full).toBe(true)
    expect(result.total).toBe(100_000)
    expect(result.entries).toHaveLength(100_000)
    // The same R3 budget the account projection build is held to (with headroom
    // for the local grouping that the server normally does).
    expect(buildMs).toBeLessThan(8000)

    /**
     * The fake worker calls the handler in-process, so `buildMs` does not include
     * the real boundary's structured clone. Measure it explicitly: production
     * pays it on the main thread when the producer posts 200k occurrences and
     * again when 100k rows come back. The main-thread IndexedDB read that feeds
     * the request is a separate cost (noted in the report; it cannot be measured
     * without writing 200k rows into fake-indexeddb).
     */
    const requestCloneStarted = performance.now()
    const clonedRequest = structuredClone(occurrences)
    const requestCloneMs = performance.now() - requestCloneStarted
    expect(clonedRequest).toHaveLength(200_000)
    expect(requestCloneMs).toBeLessThan(4000)

    const responseCloneStarted = performance.now()
    const clonedResponse = structuredClone(result.entries)
    const responseCloneMs = performance.now() - responseCloneStarted
    expect(clonedResponse).toHaveLength(100_000)
    expect(responseCloneMs).toBeLessThan(4000)

    expect(await client.search('word-099999', 'en')).toEqual(['word-099999'])
    client.terminate()
  }, 30_000)
})

/* ------------------------------------------------------------------------- *
 * Producer: storage, triggers, incremental writes
 * ------------------------------------------------------------------------- */

describe('local projection producer', () => {
  beforeEach(async () => {
    await deleteLocalDatabase()
    disposeLocalProjectionWorker()
    useOccurrencesStore.setState({
      byLanguage: {},
      occurrences: [],
      recorded: {},
      refreshing: false,
    })
    useWordStatesStore.setState({ byKey: {}, loaded: {} })
    useWordbookStore.setState({
      entriesByLanguage: {},
      loadedLanguages: {},
      projectionCompleteByLanguage: {},
      status: 'idle',
      error: null,
      revision: 0,
      dataRevision: 0,
    })
    useDocumentsStore.setState({
      documents: [
        { id: 'd1', title: 'Doc One', languageCode: 'en', rawText: '', createdAt: '', updatedAt: '' },
        { id: 'd2', title: 'Doc Two', languageCode: 'en', rawText: '', createdAt: '', updatedAt: '' },
        { id: 'd3', title: 'Doc Three', languageCode: 'en', rawText: '', createdAt: '', updatedAt: '' },
      ],
      loading: false,
      ready: true,
    })
  })

  it('writes wordbookEntries from local occurrences and states', async () => {
    await seedOccurrences(
      PARITY_OCCURRENCES.filter((row) => row.documentId !== 'd3' || row.lemma === 'fox'),
    )
    await seedStates(PARITY_STATES)
    const sink = { setEntries: vi.fn(), applyEntries: vi.fn() }
    const producer = createLocalProjectionProducer({ worker: inlineWorker(), sink })

    await producer.rebuildLanguage('en')

    const rows = await readWordbookEntries('en')
    expect(rows.map((row) => row.lemma).sort()).toEqual(['apple', 'bird', 'dog', 'fox'])
    expect(rows.find((row) => row.lemma === 'apple')).toMatchObject({
      languageCode: 'en',
      status: 'known',
      isFavorite: true,
      starColor: '#ef4444',
      note: 'remember this',
      occurrenceCount: 3,
      documentCount: 2,
      knownPresses: 4,
      serverUpdatedAt: null,
    })
    expect(rows.find((row) => row.lemma === 'bird')?.status).toBeNull()
    expect(sink.setEntries).toHaveBeenCalledTimes(1)
    expect(sink.setEntries.mock.calls[0][0]).toBe('en')
  })

  it('updates only the lemmas of a re-recorded document', async () => {
    await seedOccurrences([
      occurrence({ lemma: 'apple', documentId: 'd1', sentence: 'Old apple.' }),
      occurrence({ lemma: 'dog', documentId: 'd2', sentence: 'A dog.' }),
    ])
    const sink = { setEntries: vi.fn(), applyEntries: vi.fn() }
    const producer = createLocalProjectionProducer({ worker: inlineWorker(), sink })
    await producer.rebuildLanguage('en')
    sink.applyEntries.mockClear()

    await replaceOccurrences('d1', [
      occurrence({ lemma: 'apple', documentId: 'd1', sentence: 'New apple.' }),
      occurrence({ lemma: 'cat', documentId: 'd1', sentence: 'A cat.' }),
    ])
    await producer.updateDocument('en', 'd1')

    expect(sink.applyEntries).toHaveBeenCalledTimes(1)
    const [languageCode, entries, removed] = sink.applyEntries.mock.calls[0]
    expect(languageCode).toBe('en')
    expect((entries as { lemma: string }[]).map((entry) => entry.lemma).sort()).toEqual([
      'apple',
      'cat',
    ])
    expect(removed).toEqual([])
    const rows = await readWordbookEntries('en')
    expect(rows.map((row) => row.lemma).sort()).toEqual(['apple', 'cat', 'dog'])
    const apple = rows.find((row) => row.lemma === 'apple')
    expect(apple?.contexts).toEqual([{ documentId: 'd1', sentence: 'New apple.' }])
  })

  it('patches exactly one row on a word-state change', async () => {
    await seedOccurrences([
      occurrence({ lemma: 'apple', documentId: 'd1' }),
      occurrence({ lemma: 'dog', documentId: 'd2' }),
    ])
    const producer = createLocalProjectionProducer({
      worker: inlineWorker(),
      sink: { setEntries: vi.fn(), applyEntries: vi.fn() },
    })
    await producer.rebuildLanguage('en')
    const before = await readWordbookEntries('en')

    await producer.updateState(
      'en',
      'apple',
      wordState('apple', 'known', { favorite: true, note: 'local note' }),
    )

    const after = await readWordbookEntries('en')
    expect(after.find((row) => row.lemma === 'apple')).toMatchObject({
      status: 'known',
      isFavorite: true,
      note: 'local note',
    })
    // The other row was not rewritten at all.
    expect(after.find((row) => row.lemma === 'dog')).toEqual(
      before.find((row) => row.lemma === 'dog'),
    )
    // A state without an occurrence is not inserted into the projection.
    await producer.updateState('en', 'ghost', wordState('ghost', 'known'))
    expect((await readWordbookEntries('en')).map((row) => row.lemma).sort()).toEqual([
      'apple',
      'dog',
    ])
  })

  it('drops a purged document but keeps a shared lemma', async () => {
    await seedOccurrences([
      occurrence({ lemma: 'apple', documentId: 'd1', count: 2 }),
      occurrence({ lemma: 'apple', documentId: 'd2', count: 1 }),
      occurrence({ lemma: 'dog', documentId: 'd2' }),
    ])
    const sink = { setEntries: vi.fn(), applyEntries: vi.fn() }
    const producer = createLocalProjectionProducer({ worker: inlineWorker(), sink })
    await producer.rebuildLanguage('en')
    sink.applyEntries.mockClear()

    await idbDeleteByIndex(STORES.wordOccurrences, 'documentId', 'd2')
    await producer.removeDocuments('en', ['d2'])

    const rows = await readWordbookEntries('en')
    expect(rows.map((row) => row.lemma)).toEqual(['apple'])
    expect(rows[0]).toMatchObject({ occurrenceCount: 2, documentCount: 1 })
    const [, entries, removed] = sink.applyEntries.mock.calls[0]
    expect((entries as { lemma: string }[]).map((entry) => entry.lemma)).toEqual(['apple'])
    expect(removed).toEqual(['dog'])
  })

  it('builds a language once for repeated start-up signals', async () => {
    await seedOccurrences([occurrence({ lemma: 'apple' })])
    const inline = inlineWorker()
    const localRebuild = vi.fn(inline.localRebuild.bind(inline))
    const worker = { localRebuild }
    const producer = createLocalProjectionProducer({
      worker,
      sink: { setEntries: vi.fn(), applyEntries: vi.fn() },
    })

    await Promise.all([producer.ensureLanguage('en'), producer.ensureLanguage('en')])
    await producer.ensureLanguage('en')
    expect(localRebuild).toHaveBeenCalledTimes(1)
    // The occurrence load that changed nothing also costs nothing.
    producer.handle({ type: 'language', languageCode: 'en' })
    await Promise.resolve()
    await Promise.resolve()
    expect(localRebuild).toHaveBeenCalledTimes(1)

    // A lemma-version rebuild is explicit and recomputes the language.
    await producer.rebuildLanguage('en')
    expect(localRebuild).toHaveBeenCalledTimes(2)
  })

  it('shows local rows through the wordbook store exactly like a projection', async () => {
    await seedOccurrences(PARITY_OCCURRENCES)
    const producer = createLocalProjectionProducer({
      worker: inlineWorker(),
      sink: {
        setEntries: (languageCode, entries) =>
          useWordbookStore.getState().setLocalEntries(languageCode, entries),
        applyEntries: (languageCode, entries, removed) =>
          useWordbookStore.getState().applyLocalEntries(languageCode, entries, removed),
      },
    })
    await producer.rebuildLanguage('en')

    const store = useWordbookStore.getState()
    expect(store.loadedLanguages.en).toBe(true)
    const entries = store.entriesByLanguage.en
    expect(entries.map((entry) => entry.lemma).sort()).toEqual([
      'apple',
      'bird',
      'dog',
      'fox',
    ])
    expect(entries.find((entry) => entry.lemma === 'fox')?.documentTitle).toBe('Doc Three')

    // Titles are resolved from live document metadata, not copied into a row.
    useDocumentsStore.setState({
      documents: [
        { id: 'd1', title: 'Doc One', languageCode: 'en', rawText: '', createdAt: '', updatedAt: '' },
        { id: 'd2', title: 'Doc Two', languageCode: 'en', rawText: '', createdAt: '', updatedAt: '' },
        { id: 'd3', title: 'Renamed Three', languageCode: 'en', rawText: '', createdAt: '', updatedAt: '' },
      ],
      loading: false,
      ready: true,
    })
    expect(
      useWordbookStore
        .getState()
        .entriesByLanguage.en.find((entry) => entry.lemma === 'fox')?.documentTitle,
    ).toBe('Renamed Three')

    // A local status edit patches one row; the others keep their identity.
    const before = useWordbookStore.getState().entriesByLanguage.en
    useWordStatesStore.getState().setStatus('en', 'fox', 'known')
    const after = useWordbookStore.getState().entriesByLanguage.en
    expect(after).not.toBe(before)
    expect(after.find((entry) => entry.lemma === 'fox')?.status).toBe('known')
    for (const lemma of ['apple', 'bird', 'dog']) {
      expect(after.find((entry) => entry.lemma === lemma)).toBe(
        before.find((entry) => entry.lemma === lemma),
      )
    }
  })

  it('does not write a build that a reset fenced', async () => {
    const occurrences = [occurrence({ lemma: 'apple', documentId: 'd1' })]
    const worker = deferredWorker()
    const sink = { setEntries: vi.fn(), applyEntries: vi.fn() }
    const producer = createLocalProjectionProducer({
      worker,
      sink,
      readOccurrences: async () => occurrences,
      readWordStates: async () => [],
    })
    const built = buildLocalProjection(occurrences, [])
    const build: LocalProjectionBuild = {
      entries: built,
      removed: [],
      total: built.length,
      full: true,
    }

    const rebuilding = producer.rebuildLanguage('en')
    await vi.waitFor(() => expect(worker.calls).toHaveLength(1))

    // The device links an account while the worker is still building.
    await producer.reset()
    expect(worker.localClear).toHaveBeenCalledTimes(1)

    worker.resolve(0, build)
    await rebuilding

    // The fenced build never cleared, wrote, or replaced the store.
    expect(sink.setEntries).not.toHaveBeenCalled()
    expect(await readWordbookEntries('en')).toEqual([])

    // The producer is still usable for a later local-only session.
    const again = producer.rebuildLanguage('en')
    await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
    worker.resolve(1, build)
    await again
    expect(sink.setEntries).toHaveBeenCalledTimes(1)
    expect(await readWordbookEntries('en')).toHaveLength(1)
  })

  it('releases the worker dataset when the device links an account', async () => {
    await seedOccurrences([occurrence({ lemma: 'apple', documentId: 'd1' })])
    const worker = inlineWorker()
    const producer = createLocalProjectionProducer({
      worker,
      sink: { setEntries: vi.fn(), applyEntries: vi.fn() },
    })
    await producer.rebuildLanguage('en')
    expect(await worker.search('', 'en')).toEqual(['apple'])

    await producer.reset()
    // The local source rows and index are gone, not just the producer's `built`
    // set — otherwise the worker would hold a 200k language for the whole page.
    expect(await worker.search('', 'en')).toEqual([])

    await producer.rebuildLanguage('en')
    expect(await worker.search('', 'en')).toEqual(['apple'])
  })

  it('releases the shared worker dataset on reset (the app path)', async () => {
    await seedOccurrences([occurrence({ lemma: 'apple', documentId: 'd1' })])
    // No injected worker: this is the shared client App uses for local-only
    // search, and the one that must not keep the source rows after linking.
    const producer = createLocalProjectionProducer({
      sink: { setEntries: vi.fn(), applyEntries: vi.fn() },
    })
    await producer.rebuildLanguage('en')
    expect(await searchLocalProjection('', 'en')).toEqual(['apple'])

    await producer.reset()
    expect(await searchLocalProjection('', 'en')).toEqual([])
  })

  it('releases the worker dataset on dispose too', async () => {
    await seedOccurrences([occurrence({ lemma: 'apple', documentId: 'd1' })])
    const worker = inlineWorker()
    const producer = createLocalProjectionProducer({
      worker,
      sink: { setEntries: vi.fn(), applyEntries: vi.fn() },
    })
    await producer.rebuildLanguage('en')
    expect(await worker.search('', 'en')).toEqual(['apple'])

    producer.dispose()
    expect(await worker.search('', 'en')).toEqual([])
  })

  it('rebuilds an entry when a stale lemma version recomputes a document', async () => {
    const doc: Document = {
      id: 'd1',
      title: 'Doc One',
      languageCode: 'en',
      rawText: 'The cat sat.',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    }
    // The stored rows came from an older lemma rule.
    await seedOccurrences([
      occurrence({ lemma: 'oldword', documentId: 'd1', documentTitle: 'Doc One' }),
    ])
    await idbPut(STORES.documentMeta, {
      documentId: 'd1',
      lemmaVersion: 0,
      segmenter: 'intl',
    })
    const sink = { setEntries: vi.fn(), applyEntries: vi.fn() }
    const producer = createLocalProjectionProducer({ worker: inlineWorker(), sink })
    await producer.rebuildLanguage('en')
    expect((await readWordbookEntries('en')).map((row) => row.lemma)).toEqual(['oldword'])

    const unsubscribe = onLocalProjectionChange((change) => {
      void producer.handle(change)
    })
    try {
      const refreshed =
        await useOccurrencesStore.getState().refreshStaleDocuments([doc])
      expect(refreshed).toBe(1)
      await producer.flush()
    } finally {
      unsubscribe()
    }

    const rows = await readWordbookEntries('en')
    expect(rows.map((row) => row.lemma)).toContain('cat')
    expect(rows.map((row) => row.lemma)).not.toContain('oldword')
    expect(sink.applyEntries).toHaveBeenCalled()
  })

  it('never calls a projection RPC or the network', async () => {
    // Every module on the local-only path must stay free of the server read
    // model. A future edit that imports it into the producer, the worker, or the
    // projection storage fails here instead of only in production.
    for (const file of [
      './localProjection.ts',
      './wordbookWorker.ts',
      '../../lib/storage/wordbookEntries.ts',
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(source, file).not.toMatch(/wordbookPull|pullProjectionPage|supabase|\.rpc\(/)
    }

    await seedOccurrences([occurrence({ lemma: 'apple' })])
    const producer = createLocalProjectionProducer({
      worker: inlineWorker(),
      sink: { setEntries: vi.fn(), applyEntries: vi.fn() },
    })
    const fetchSpy = vi.fn()
    const original = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      await producer.rebuildLanguage('en')
      await producer.updateState('en', 'apple', wordState('apple', 'known'))
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = original
    }
  })
})

/* ------------------------------------------------------------------------- *
 * Store triggers
 * ------------------------------------------------------------------------- */

describe('local projection triggers', () => {
  beforeEach(async () => {
    await deleteLocalDatabase()
    useOccurrencesStore.setState({
      byLanguage: {},
      occurrences: [],
      recorded: {},
      refreshing: false,
    })
    useWordStatesStore.setState({ byKey: {}, loaded: {} })
  })

  function collect(): { events: LocalProjectionChange[]; off: () => void } {
    const events: LocalProjectionChange[] = []
    const off = onLocalProjectionChange((change) => events.push(change))
    return { events, off }
  }

  it('announces a recorded document, and not an unchanged recomputation', async () => {
    const { events, off } = collect()
    const doc: Document = {
      id: 'd1',
      title: 'Doc One',
      languageCode: 'en',
      rawText: 'The cat sat. The dog ran.',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    }
    try {
      await useOccurrencesStore.getState().recordDocument(doc)
      expect(events).toContainEqual({
        type: 'document',
        languageCode: 'en',
        documentId: 'd1',
      })

      // The no-op occurrence guard must stay silent: nothing changed, so there
      // is nothing for the projection to rebuild.
      events.length = 0
      await useOccurrencesStore.getState().recordDocument(doc, true)
      expect(events).toEqual([])
    } finally {
      off()
    }
  })

  it('announces a language load only when its content changed', async () => {
    await seedOccurrences([occurrence({ lemma: 'apple', documentId: 'd1' })])
    const { events, off } = collect()
    try {
      await useOccurrencesStore.getState().loadLanguage('en')
      expect(events).toEqual([{ type: 'language', languageCode: 'en' }])

      events.length = 0
      await useOccurrencesStore.getState().loadLanguage('en')
      expect(events).toEqual([])
    } finally {
      off()
    }
  })

  it('announces a purged document for each language it belonged to', async () => {
    const rows = [
      occurrence({ lemma: 'apple', documentId: 'd1' }),
      occurrence({ lemma: 'pomme', documentId: 'd1', languageCode: 'fr' }),
    ]
    await seedOccurrences(rows)
    useOccurrencesStore.setState({
      byLanguage: { en: [rows[0]], fr: [rows[1]] },
      occurrences: rows,
      recorded: { d1: true },
    })
    const { events, off } = collect()
    try {
      await useOccurrencesStore.getState().forgetDocument('d1')
      expect(events).toHaveLength(2)
      expect(events).toEqual(
        expect.arrayContaining([
          { type: 'documents-removed', languageCode: 'en', documentIds: ['d1'] },
          { type: 'documents-removed', languageCode: 'fr', documentIds: ['d1'] },
        ]),
      )
    } finally {
      off()
    }
  })

  it('announces each state edit once, with the new state', async () => {
    const { events, off } = collect()
    const states = useWordStatesStore.getState()
    try {
      states.setStatus('en', 'cat', 'known')
      expect(events.at(-1)).toMatchObject({
        type: 'state',
        languageCode: 'en',
        lemma: 'cat',
        state: { status: 'known' },
      })

      events.length = 0
      states.toggleFavorite('en', 'cat')
      expect(events.at(-1)).toMatchObject({
        type: 'state',
        lemma: 'cat',
        state: { favorite: true },
      })

      events.length = 0
      states.setNote('en', 'cat', 'my note')
      expect(events.at(-1)).toMatchObject({
        type: 'state',
        lemma: 'cat',
        state: { note: 'my note' },
      })
    } finally {
      off()
    }
  })
})
