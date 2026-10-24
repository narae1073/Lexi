import 'fake-indexeddb/auto'

import { beforeEach, describe, expect, it } from 'vitest'

import { useDocumentsStore } from '../../app/stores/documents'
import { useWordbookStore } from '../../app/stores/wordbook'
import { useWordStatesStore } from '../../app/stores/wordStates'
import { buildWordbook } from './buildWordbook'
import type { WordOccurrence } from '../../app/stores/occurrences'
import type { WordState, WordStatus } from '../../types'
import { deleteLocalDatabase } from '../../lib/storage/localDb'
import { putWordbookEntries } from '../../lib/storage/wordbookEntries'
import type { WordbookEntryRecord } from '../../lib/storage/wordbookEntries'
import { writeProjectionState } from '../../lib/sync/projectionState'
import {
  computeDocumentProgress,
  preparationProgress,
  projectionEntriesToWordbook,
  projectionEntryToWordbook,
  resolveWordbookPresentation,
  resolveWordbookRowSource,
  searchProjectionEntries,
  sortWordbookEntries,
  type ProjectionEntry,
  type ProjectionWordbookEntry,
} from './wordbookProjection'

function record(over: Partial<WordbookEntryRecord> & { lemma: string }): ProjectionEntry {
  return {
    languageCode: 'en',
    surfaces: [over.lemma],
    contexts: [],
    occurrenceCount: 1,
    documentCount: 1,
    status: null,
    isFavorite: false,
    starAngle: 0,
    starColor: '#eab308',
    seenCount: 1,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: null,
    favoriteUpdatedAt: null,
    knownPresses: 0,
    unsurePresses: 0,
    unknownPresses: 0,
    note: null,
    noteUpdatedAt: null,
    serverUpdatedAt: null,
    ...over,
  }
}

function wordState(lemma: string, status?: WordStatus): WordState {
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
  }
}

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

/** The visible shape, without the extra document id used only for progress. */
function visible(entry: ProjectionWordbookEntry) {
  return {
    lemma: entry.lemma,
    surfaces: entry.surfaces,
    status: entry.status,
    favorite: entry.favorite,
    starColor: entry.starColor,
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

describe('projection wordbook rows', () => {
  const documents = [
    { id: 'd1', title: 'Doc One' },
    { id: 'd2', title: 'Doc Two' },
    { id: 'd3', title: 'Doc Three', deletedAt: '2026-03-03T00:00:00.000Z' },
  ]

  const occurrences: WordOccurrence[] = [
    // Occurrence titles are deliberately stale (old names) — the projection
    // must resolve the current document title instead.
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
    // Empty sentence: it is not a context, and the row keeps an empty example.
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
      count: 1,
      sentence: 'A fox runs.',
      recordedAt: 4000,
    }),
  ]

  const states: Record<string, WordState> = {
    'en::apple': {
      ...wordState('apple', 'known'),
      favorite: true,
      starColor: '#ef4444',
      note: 'remember this',
      lastSeenAt: '2026-10-01T00:00:00.000Z',
      knownPresses: 4,
    },
    'en::fox': wordState('fox', 'unsure'),
    // A state row can exist without a status (favorite/note/press history).
    'en::dog': {
      ...wordState('dog'),
      lastSeenAt: '2026-01-01T00:00:00.000Z',
    },
  }

  const projection: ProjectionEntry[] = [
    record({
      lemma: 'apple',
      surfaces: ['apple', 'Apple'],
      contexts: [
        { documentId: 'd1', sentence: 'An apple is red.' },
        { documentId: 'd2', sentence: 'Apple pie is sweet.' },
      ],
      occurrenceCount: 3,
      documentCount: 2,
    }),
    record({
      lemma: 'dog',
      surfaces: ['dog'],
      contexts: [{ documentId: 'd2', sentence: '' }],
      occurrenceCount: 3,
      documentCount: 1,
      lastSeenAt: '2026-01-01T00:00:00.000Z',
    }),
    record({
      lemma: 'fox',
      contexts: [{ documentId: 'd3', sentence: 'A fox runs.' }],
      occurrenceCount: 1,
      documentCount: 1,
    }),
  ]

  it('produces the same visible rows as buildWordbook', () => {
    const expected = buildWordbook({
      languageCode: 'en',
      occurrences,
      byKey: states,
    })
      .map((entry) => visible(entry as unknown as ProjectionWordbookEntry))
      .sort((a, b) => a.lemma.localeCompare(b.lemma, 'en'))

    const actual = sortWordbookEntries(
      projectionEntriesToWordbook(projection, {
        documents,
        stateOf: (lemma) => states[`en::${lemma}`],
      }),
      'en',
    ).map(visible)

    // BuildWordbook's contexts do not carry a document id; the projection row
    // does. Everything a user can see must still agree.
    expect(actual.map(({ lemma }) => lemma)).toEqual(expected.map(({ lemma }) => lemma))
    expect(actual).toEqual(expected)
  })

  it('resolves current document titles and never falls back to a stale occurrence title', () => {
    const entries = projectionEntriesToWordbook([projection[0]], {
      documents: [{ id: 'd1', title: 'New Title' }],
    })
    expect(entries[0].documentTitle).toBe('New Title')
    expect(entries[0].sentence).toBe('An apple is red.')
  })

  it('uses an empty title for a document that no longer exists, not an old one', () => {
    const entry = projectionEntryToWordbook(
      record({
        lemma: 'ghost',
        contexts: [{ documentId: 'gone', sentence: 'A ghost.' }],
        documentCount: 1,
      }),
      { documents },
    )
    expect(entry.documentTitle).toBe('')
    expect(entry.contexts).toEqual([{ sentence: 'A ghost.', documentTitle: '', documentId: 'gone' }])
  })

  it('keeps every state and count field from the projection', () => {
    const entry = projectionEntriesToWordbook(
      [
        record({
          lemma: 'run',
          surfaces: ['run', 'ran'],
          status: 'known',
          isFavorite: true,
          starColor: '#3b82f6',
          note: 'note',
          lastSeenAt: '2026-09-09T00:00:00.000Z',
          knownPresses: 7,
          occurrenceCount: 12,
          documentCount: 3,
        }),
      ],
      { documents },
    )[0]

    expect(entry).toMatchObject({
      lemma: 'run',
      surfaces: ['run', 'ran'],
      status: 'known',
      favorite: true,
      starColor: '#3b82f6',
      note: 'note',
      lastSeenAt: '2026-09-09T00:00:00.000Z',
      knownPresses: 7,
      count: 12,
      documentCount: 3,
    })
  })

  it('lets a dirty local state win over an older projection row', () => {
    const entry = projectionEntryToWordbook(record({ lemma: 'cat', status: 'unknown' }), {
      documents,
      stateOf: (lemma) => (lemma === 'cat' ? wordState('cat', 'known') : undefined),
    })
    expect(entry.status).toBe('known')
  })
})

describe('projection search', () => {
  const entries = projectionEntriesToWordbook(
    [
      record({ lemma: 'Apple', surfaces: ['Apple', 'apple'] }),
      record({ lemma: 'café', surfaces: ['café'] }),
      record({ lemma: 'a.b', surfaces: ['a.b'] }),
      record({ lemma: 'US', surfaces: ['US'] }),
      record({ lemma: 'us', surfaces: ['us'] }),
    ],
    { documents: [{ id: 'd1', title: 'Doc' }] },
  )

  const lemmas = (query: string) =>
    searchProjectionEntries(entries, query, 'en').map((entry) => entry.lemma)

  it('matches lemmas and surfaces case-insensitively', () => {
    expect(lemmas('app')).toEqual(['Apple'])
    expect(lemmas('CAF')).toEqual(['café'])
  })

  it('treats special characters literally and never throws', () => {
    expect(lemmas('.')).toEqual(['a.b'])
    expect(lemmas('.*')).toEqual([])
    expect(lemmas('[a-z]')).toEqual([])
    expect(lemmas('\\')).toEqual([])
    expect(lemmas('(')).toEqual([])
    expect(() => lemmas('😀')).not.toThrow()
  })

  it('returns every row, sorted, for a blank query', () => {
    expect(lemmas('   ')).toEqual(['a.b', 'Apple', 'café', 'US', 'us'])
  })

  it('keeps US and us separate', () => {
    expect(lemmas('us')).toEqual(['US', 'us'])
  })
})

describe('document progress from projection contexts', () => {
  const documents = [
    { id: 'd1', title: 'One' },
    { id: 'd2', title: 'Two' },
    { id: 'paged', title: 'Paged' },
    { id: 'trash', title: 'Trash', deletedAt: '2026-03-03T00:00:00.000Z' },
  ]

  const entries = projectionEntriesToWordbook(
    [
      record({
        lemma: 'shared',
        status: 'known',
        contexts: [
          { documentId: 'd1', sentence: 'Shared one.' },
          { documentId: 'd2', sentence: 'Shared two.' },
          { documentId: 'paged', sentence: 'Shared paged.' },
        ],
        documentCount: 3,
      }),
      record({
        lemma: 'only-one',
        contexts: [{ documentId: 'd1', sentence: 'Only one.' }],
      }),
      record({
        lemma: 'unsure-two',
        status: 'unsure',
        contexts: [{ documentId: 'd2', sentence: 'Unsure two.' }],
      }),
      record({
        lemma: 'trashed',
        status: 'known',
        contexts: [{ documentId: 'trash', sentence: 'In trash.' }],
      }),
      record({
        lemma: 'empty-sentence-only',
        status: 'known',
        contexts: [{ documentId: 'paged', sentence: '' }],
      }),
    ],
    { documents },
  )

  it('counts distinct lemmas per document and handles shared lemmas', () => {
    const progress = computeDocumentProgress(entries, documents)
    // d1: shared (known) + only-one (unmarked) = 2 words, 1 marked
    expect(progress.get('d1')).toEqual({ total: 2, marked: 1, percent: 50 })
    // d2: shared (known) + unsure-two (unsure, marked) = 2 words, 2 marked
    expect(progress.get('d2')).toEqual({ total: 2, marked: 2, percent: 100 })
  })

  it('works for a paged document with no occurrence rows', () => {
    const progress = computeDocumentProgress(entries, documents)
    // paged: shared + empty-sentence-only (the association survives the empty sentence)
    expect(progress.get('paged')).toEqual({ total: 2, marked: 2, percent: 100 })
  })

  it('ignores contexts for deleted documents', () => {
    const progress = computeDocumentProgress(entries, documents)
    expect(progress.has('trash')).toBe(false)
  })

  it('counts a repeated context once', () => {
    const repeated = projectionEntriesToWordbook(
      [
        record({
          lemma: 'cat',
          status: 'known',
          contexts: [
            { documentId: 'd1', sentence: 'Cat one.' },
            { documentId: 'd1', sentence: 'Cat two.' },
          ],
        }),
      ],
      { documents },
    )
    expect(computeDocumentProgress(repeated, documents).get('d1')).toEqual({
      total: 1,
      marked: 1,
      percent: 100,
    })
  })
})

describe('wordbook source selection', () => {
  const input = {
    localOnly: false,
    projectionReady: false,
    projectionPaused: false,
    hasLocalWordbook: false,
  }

  it('keeps the local wordbook visible for an R2 upgrade while the projection is incomplete', () => {
    const presentation = resolveWordbookPresentation({
      ...input,
      hasLocalWordbook: true,
    })
    expect(presentation).toEqual({
      source: 'local',
      showPreparation: false,
      showPaused: false,
      showContinue: false,
    })
  })

  it('shows preparation instead of an empty wordbook on a brand-new device', () => {
    const presentation = resolveWordbookPresentation(input)
    expect(presentation.source).toBe('preparing')
    expect(presentation.showPreparation).toBe(true)
    expect(preparationProgress({ en: false }, ['en'])).toEqual({
      ready: 0,
      total: 1,
      percent: 0,
    })
  })

  it('shows a paused/continue state for a projection paused by the 64 MB cap', () => {
    const withLocal = resolveWordbookPresentation({
      ...input,
      projectionPaused: true,
      hasLocalWordbook: true,
    })
    expect(withLocal).toMatchObject({
      source: 'local',
      showPaused: true,
      showContinue: true,
    })

    const noLocal = resolveWordbookPresentation({ ...input, projectionPaused: true })
    expect(noLocal).toMatchObject({
      source: 'preparing',
      showPreparation: true,
      showPaused: true,
      showContinue: true,
    })
    expect(preparationProgress({ en: true, fr: false }, ['en', 'fr'])).toEqual({
      ready: 1,
      total: 2,
      percent: 50,
    })
  })

  it('switches to the projection (worker) path once the projection is complete and loaded', () => {
    const presentation = resolveWordbookPresentation({
      ...input,
      projectionReady: true,
      hasLocalWordbook: true,
    })
    expect(presentation).toEqual({
      source: 'projection',
      showPreparation: false,
      showPaused: false,
      showContinue: false,
    })
  })

  it('leaves local-only mode on the local path', () => {
    expect(resolveWordbookPresentation({ ...input, localOnly: true })).toEqual({
      source: 'local',
      showPreparation: false,
      showPaused: false,
      showContinue: false,
    })
  })
})

describe('wordbook row selection', () => {
  const input = {
    localOnly: false,
    presentation: 'local' as const,
    projectionReady: false,
    sortedReady: false,
  }

  it('keeps the occurrence-built rows for an account R2 upgrade', () => {
    expect(resolveWordbookRowSource(input)).toBe('legacy')
    expect(resolveWordbookRowSource({ ...input, presentation: 'preparing' })).toBe('projection')
    expect(resolveWordbookRowSource({ ...input, presentation: 'projection' })).toBe('projection')
  })

  it('uses local projection rows only after the first worker search resolves', () => {
    const local = { ...input, localOnly: true }
    // Producer still building: the previous list stays on screen.
    expect(resolveWordbookRowSource(local)).toBe('legacy')
    // Rows loaded, but the worker has not answered yet: still no empty flash.
    expect(resolveWordbookRowSource({ ...local, projectionReady: true })).toBe('legacy')
    // First search resolved: the read model takes over.
    expect(
      resolveWordbookRowSource({ ...local, projectionReady: true, sortedReady: true }),
    ).toBe('projection')
  })
})

describe('projection readiness from persisted state', () => {
  beforeEach(async () => {
    useWordbookStore.setState({
      entriesByLanguage: {},
      loadedLanguages: {},
      projectionCompleteByLanguage: {},
      status: 'idle',
      error: null,
      revision: 0,
      dataRevision: 0,
    })
    await deleteLocalDatabase()
  })

  it('reads complete languages after an R2 upgrade and marks the rest incomplete', async () => {
    await writeProjectionState('user-1', {
      en: {
        complete: true,
        snapshot: '2026-01-01T00:00:00.000Z',
        cursor: null,
        hydratedAt: null,
      },
      fr: {
        complete: false,
        snapshot: '2026-01-01T00:00:00.000Z',
        cursor: { languageCode: 'fr', lemma: 'a' },
        hydratedAt: null,
      },
    })

    await useWordbookStore.getState().refreshProjectionReadiness('user-1')

    expect(useWordbookStore.getState().projectionCompleteByLanguage).toEqual({
      en: true,
      fr: false,
    })
  })

  it('restores per-language pause metadata after a reload', async () => {
    await writeProjectionState('user-1', {
      fr: {
        complete: false,
        snapshot: '2026-01-01T00:00:00.000Z',
        cursor: { languageCode: 'fr', lemma: 'a' },
        hydratedAt: null,
        pause: {
          reason: 'quota',
          pausedAt: '2026-01-01T00:01:00.000Z',
          nextAttemptAt: '2026-01-01T00:02:00.000Z',
          quotaBucket: 'page',
          retryAfterSeconds: 60,
        },
      },
      de: {
        complete: false,
        snapshot: '2026-01-01T00:00:00.000Z',
        cursor: null,
        hydratedAt: null,
        pause: {
          reason: 'bytes',
          pausedAt: '2026-01-01T00:01:00.000Z',
          nextAttemptAt: null,
          quotaBucket: null,
          retryAfterSeconds: null,
        },
      },
      en: {
        complete: true,
        snapshot: '2026-01-01T00:00:00.000Z',
        cursor: null,
        hydratedAt: null,
      },
    })

    await useWordbookStore.getState().refreshProjectionReadiness('user-1')

    expect(useWordbookStore.getState().projectionPauseByLanguage).toEqual({
      fr: {
        reason: 'quota',
        pausedAt: '2026-01-01T00:01:00.000Z',
        nextAttemptAt: '2026-01-01T00:02:00.000Z',
        quotaBucket: 'page',
        retryAfterSeconds: 60,
      },
      de: {
        reason: 'bytes',
        pausedAt: '2026-01-01T00:01:00.000Z',
        nextAttemptAt: null,
        quotaBucket: null,
        retryAfterSeconds: null,
      },
    })
  })

  it('treats a missing account/state as incomplete and clears pause metadata', async () => {
    await useWordbookStore.getState().refreshProjectionReadiness(null)
    expect(useWordbookStore.getState().projectionCompleteByLanguage).toEqual({})
    expect(useWordbookStore.getState().projectionPauseByLanguage).toEqual({})

    await useWordbookStore.getState().refreshProjectionReadiness('new-device-user')
    expect(useWordbookStore.getState().projectionCompleteByLanguage).toEqual({})
    expect(useWordbookStore.getState().projectionPauseByLanguage).toEqual({})
  })
})

describe('wordbook store', () => {
  beforeEach(async () => {
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
    await deleteLocalDatabase()
  })

  it('loads projection rows for one language from the local store', async () => {
    await putWordbookEntries([
      record({ lemma: 'apple', contexts: [{ documentId: 'd1', sentence: 'An apple.' }] }),
      record({ languageCode: 'fr', lemma: 'pomme' }),
    ])
    useDocumentsStore.setState({ documents: [], loading: false, ready: true })

    await useWordbookStore.getState().refreshFromStore('en')

    const entries = useWordbookStore.getState().entriesByLanguage.en
    expect(entries.map((entry) => entry.lemma)).toEqual(['apple'])
    expect(useWordbookStore.getState().status).toBe('ready')
    expect(useWordbookStore.getState().entriesByLanguage.fr).toBeUndefined()
  })

  it('updates one entry on a word-state change without rebuilding the rest', () => {
    const entries = projectionEntriesToWordbook(
      [record({ lemma: 'apple', status: 'unknown' }), record({ lemma: 'dog', status: 'unsure' })],
      { documents: [{ id: 'd1', title: 'Doc' }] },
    )
    useWordbookStore.getState().setEntries('en', entries)
    const before = useWordbookStore.getState().entriesByLanguage.en

    useWordStatesStore.setState({
      byKey: {
        'en::apple': {
          ...wordState('apple', 'known'),
          favorite: true,
          note: 'local edit',
        },
      },
    })

    const after = useWordbookStore.getState().entriesByLanguage.en
    expect(after).not.toBe(before)
    expect(after[0]).toMatchObject({
      lemma: 'apple',
      status: 'known',
      favorite: true,
      note: 'local edit',
    })
    // Untouched rows keep their identity — this is the "no full rebuild" rule.
    expect(after[1]).toBe(before[1])
  })

  it('re-resolves titles without re-reading the projection', async () => {
    await putWordbookEntries([
      record({ lemma: 'apple', contexts: [{ documentId: 'd1', sentence: 'An apple.' }] }),
    ])
    await useWordbookStore.getState().refreshFromStore('en')
    useDocumentsStore.setState({
      documents: [
        {
          id: 'd1',
          title: 'New Title',
          languageCode: 'en',
          rawText: '',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
        },
      ],
    })
    // The documents subscription runs synchronously on setState.
    const updated = useWordbookStore.getState().entriesByLanguage.en
    expect(updated[0]?.documentTitle).toBe('New Title')
  })
})
