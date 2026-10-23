import { describe, expect, it } from 'vitest'

import type { WordbookEntry } from './buildWordbook'
import type { ProjectionWordbookEntry } from './wordbookProjection'
import {
  createWordbookWorkerClient,
  createWordbookWorkerState,
  handleWordbookRequest,
  type WordbookWorkerRequest,
  type WordbookWorkerResponse,
  type WorkerLike,
} from './wordbookWorker'

function entry(lemma: string, over: Partial<WordbookEntry> = {}): WordbookEntry {
  return {
    lemma,
    surfaces: [lemma],
    status: 'unmarked',
    favorite: false,
    sentence: `A ${lemma}.`,
    documentId: 'd1',
    documentTitle: 'Doc',
    contexts: [{ sentence: `A ${lemma}.`, documentTitle: 'Doc' }],
    lastSeenAt: '',
    knownPresses: 0,
    count: 1,
    documentCount: 1,
    ...over,
  }
}

/** 116k-entry fixture — the size the R3 target names. */
function largeFixture(size = 116_000): WordbookEntry[] {
  const entries: WordbookEntry[] = []
  for (let i = 0; i < size; i += 1) {
    const lemma = `word-${String(i).padStart(6, '0')}`
    entries.push({
      lemma,
      surfaces: [lemma, `${lemma}s`],
      status: i % 3 === 0 ? 'known' : 'unmarked',
      favorite: false,
      sentence: '',
      documentId: `d${i % 10}`,
      documentTitle: `Doc ${i % 10}`,
      contexts: [],
      lastSeenAt: '',
      knownPresses: 0,
      count: 1,
      documentCount: 1,
    })
  }
  return entries
}

/**
 * A fake worker that runs the real protocol handler on a later task.
 *
 * It records every message, so the test can prove the UI boundary is
 * `postMessage` rather than a synchronous main-thread computation.
 */
class FakeWorker implements WorkerLike {
  messages: (WordbookWorkerRequest & { id?: number })[] = []
  onmessage: ((event: { data: WordbookWorkerResponse & { id?: number } }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  private readonly state = createWordbookWorkerState()

  postMessage(message: unknown): void {
    const request = message as WordbookWorkerRequest & { id?: number }
    this.messages.push(request)
    // A real worker replies asynchronously. `setTimeout` makes the boundary
    // observable: the caller's promise cannot settle in this turn.
    setTimeout(() => {
      const response = handleWordbookRequest(this.state, request)
      this.onmessage?.({ data: { ...response, id: request.id } })
    }, 0)
  }
}

describe('worker protocol', () => {
  it('sorts once and answers searches by lemma and surface', () => {
    const state = createWordbookWorkerState()
    const rebuilt = handleWordbookRequest(state, {
      type: 'rebuild',
      entries: [entry('banana'), entry('cherry'), entry('Apple', { surfaces: ['Apple', 'apple'] }), entry('apricot')],
      languageCode: 'en',
    })
    expect(rebuilt).toEqual({ type: 'rebuilt', total: 4 })

    const byLemma = handleWordbookRequest(state, { type: 'search', query: 'ap', languageCode: 'en' })
    expect(byLemma).toMatchObject({ type: 'search' })
    if (byLemma.type !== 'search') throw new Error('unexpected')
    expect(byLemma.lemmas).toEqual(['Apple', 'apricot'])

    const bySurface = handleWordbookRequest(state, {
      type: 'search',
      query: 'appl',
      languageCode: 'en',
    })
    if (bySurface.type !== 'search') throw new Error('unexpected')
    expect(bySurface.lemmas).toEqual(['Apple'])

    const all = handleWordbookRequest(state, { type: 'search', query: '', languageCode: 'en' })
    if (all.type !== 'search') throw new Error('unexpected')
    expect(all.lemmas).toEqual(['Apple', 'apricot', 'banana', 'cherry'])
  })

  it('does not crash on regular-expression special characters', () => {
    const state = createWordbookWorkerState()
    handleWordbookRequest(state, {
      type: 'rebuild',
      entries: [entry('a.b'), entry('path\\name'), entry('(paren)')],
      languageCode: 'en',
    })
    for (const query of ['.*', '[a-z]', '\\', '(', ')', '+', '?', '^$', '😀']) {
      expect(() => handleWordbookRequest(state, { type: 'search', query, languageCode: 'en' })).not.toThrow()
    }
    const literal = handleWordbookRequest(state, { type: 'search', query: 'a.b', languageCode: 'en' })
    if (literal.type !== 'search') throw new Error('unexpected')
    expect(literal.lemmas).toEqual(['a.b'])
  })

  it('computes progress from the rebuilt dataset or explicit entries', () => {
    const state = createWordbookWorkerState()
    const projected = entry('shared', {
      status: 'known',
      contexts: [{ sentence: 'Shared.', documentTitle: 'One' }],
      documentIds: ['d1', 'd2'],
    } as unknown as Partial<WordbookEntry>) as unknown as ProjectionWordbookEntry
    handleWordbookRequest(state, { type: 'rebuild', entries: [projected], languageCode: 'en' })

    const response = handleWordbookRequest(state, {
      type: 'progress',
      documents: [
        { id: 'd1' },
        { id: 'd2' },
      ],
    })
    if (response.type !== 'progress') throw new Error('unexpected')
    expect(response.progress).toEqual({
      d1: { total: 1, marked: 1, percent: 100 },
      d2: { total: 1, marked: 1, percent: 100 },
    })

    const explicitEntry = entry('new') as unknown as ProjectionWordbookEntry
    explicitEntry.documentIds = ['d1']
    const explicit = handleWordbookRequest(state, {
      type: 'progress',
      entries: [explicitEntry],
      documents: [{ id: 'd1' }],
    })
    if (explicit.type !== 'progress') throw new Error('unexpected')
    expect(explicit.progress).toEqual({ d1: { total: 1, marked: 0, percent: 0 } })
  })

  it('applies a small status override map without re-sending entries', () => {
    const state = createWordbookWorkerState()
    const projected = entry('shared', {
      status: 'unmarked',
      contexts: [{ sentence: 'Shared.', documentTitle: 'One' }],
      documentIds: ['d1'],
      languageCode: 'en',
    } as unknown as Partial<WordbookEntry>) as unknown as ProjectionWordbookEntry
    handleWordbookRequest(state, { type: 'rebuild', entries: [projected], languageCode: 'en' })

    const response = handleWordbookRequest(state, {
      type: 'progress',
      documents: [{ id: 'd1' }],
      statuses: { 'en::shared': 'known' },
    })
    if (response.type !== 'progress') throw new Error('unexpected')
    expect(response.progress).toEqual({ d1: { total: 1, marked: 1, percent: 100 } })
  })
})

describe('wordbook worker boundary', () => {
  it('sends the 116k rebuild and search through postMessage, not main-thread compute', async () => {
    const entries = largeFixture()
    const worker = new FakeWorker()
    const client = createWordbookWorkerClient({ worker })

    let settled = false
    const rebuilding = client.rebuild(entries, 'en').then(() => {
      settled = true
    })
    // The client only posted a message; the handler has not run in this turn.
    expect(settled).toBe(false)
    expect(worker.messages.map((message) => message.type)).toEqual(['rebuild'])

    const rebuildStarted = performance.now()
    await rebuilding
    const rebuildMs = performance.now() - rebuildStarted
    expect(settled).toBe(true)

    const searchStarted = performance.now()
    const lemmas = await client.search('word-011600', 'en')
    const searchMs = performance.now() - searchStarted

    expect(worker.messages.map((message) => message.type)).toEqual(['rebuild', 'search'])
    expect(lemmas).toEqual(['word-011600'])
    // The R3 targets: first wordbook under 2.5 s, search under 200 ms.
    expect(rebuildMs).toBeLessThan(2500)
    expect(searchMs).toBeLessThan(200)
    expect(entries).toHaveLength(116_000)
    client.terminate()
  }, 20_000)

  it('computes progress through the worker', async () => {
    const worker = new FakeWorker()
    const client = createWordbookWorkerClient({ worker })
    const projected = entry('shared', {
      status: 'known',
      contexts: [{ sentence: 'Shared.', documentTitle: 'One' }],
      documentIds: ['d1', 'paged'],
    } as unknown as Partial<WordbookEntry>) as unknown as ProjectionWordbookEntry

    const progress = await client.progress([projected], [{ id: 'd1' }, { id: 'paged' }])
    expect(progress.get('d1')).toEqual({ total: 1, marked: 1, percent: 100 })
    expect(progress.get('paged')).toEqual({ total: 1, marked: 1, percent: 100 })
    expect(worker.messages.map((message) => message.type)).toEqual(['progress'])
    client.terminate()
  })

  it('falls back to the same semantics when no Worker exists', async () => {
    const client = createWordbookWorkerClient({ inline: true })
    await client.rebuild([entry('dog'), entry('cat')], 'en')
    expect(await client.search('ca', 'en')).toEqual(['cat'])
    expect(await client.search('zzz', 'en')).toEqual([])
    client.terminate()
  })
})
