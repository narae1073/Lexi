import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import { useWordStatesStore } from '../../app/stores/wordStates'
import { deleteLocalDatabase } from './localDb'
import {
  appendWordStateEvent,
  clearWordStateEvents,
  ensureWordStateBaseline,
  readWordStateEvents,
} from './wordStateEvents'
import {
  autoTimelineBucket,
  buildWordStateTimeline,
  downsampleTimeline,
} from './wordStateTimeline'

beforeEach(async () => {
  await deleteLocalDatabase()
})

describe('local word-state timeline events', () => {
  it('seeds a baseline once and appends effective changes', async () => {
    await ensureWordStateBaseline('en', [
      { lemma: 'known', status: 'known' },
      { lemma: 'unsure', status: 'unsure' },
      { lemma: 'unmarked' },
    ])
    await ensureWordStateBaseline('en', [{ lemma: 'known', status: 'known' }])

    let events = await readWordStateEvents('en')
    expect(events).toHaveLength(2)
    expect(events.every((event) => event.source === 'baseline')).toBe(true)

    await appendWordStateEvent({
      languageCode: 'en',
      lemma: 'known',
      oldStatus: 'known',
      newStatus: 'unsure',
      source: 'reader',
      occurredAt: '2026-10-24T10:30:00.000Z',
    })
    events = await readWordStateEvents('en')
    expect(events).toHaveLength(3)
    expect(events.find((event) => event.source === 'reader')).toMatchObject({
      lemma: 'known',
      oldStatus: 'known',
      newStatus: 'unsure',
      source: 'reader',
    })

    await clearWordStateEvents('en')
    expect(await readWordStateEvents('en')).toEqual([])
  })

  it('records the source from the central word-state write path', async () => {
    useWordStatesStore.setState({ byKey: {}, loaded: {} })
    useWordStatesStore.getState().setStatus('en', 'apple', 'known', 'apple', 'wordbook')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const events = await readWordStateEvents('en')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      lemma: 'apple',
      oldStatus: null,
      newStatus: 'known',
      source: 'wordbook',
    })
  })

  it('does not write a no-op status event', async () => {
    await appendWordStateEvent({
      languageCode: 'en',
      lemma: 'same',
      oldStatus: 'known',
      newStatus: 'known',
      source: 'wordbook',
    })
    expect(await readWordStateEvents('en')).toEqual([])
  })
})

describe('word-state timeline aggregation', () => {
  const now = Date.parse('2026-10-24T11:00:00.000Z')

  it('moves counts between states and treats new as unknown', () => {
    const points = buildWordStateTimeline(
      [
        {
          documentId: 'event:1',
          version: 1,
          id: '1',
          languageCode: 'en',
          lemma: 'a',
          oldStatus: null,
          newStatus: 'known',
          source: 'baseline',
          occurredAt: '2026-10-24T10:10:00.000Z',
        },
        {
          documentId: 'event:2',
          version: 1,
          id: '2',
          languageCode: 'en',
          lemma: 'b',
          oldStatus: null,
          newStatus: 'unknown',
          source: 'baseline',
          occurredAt: '2026-10-24T10:10:00.000Z',
        },
        {
          documentId: 'event:3',
          version: 1,
          id: '3',
          languageCode: 'en',
          lemma: 'a',
          oldStatus: 'known',
          newStatus: 'unsure',
          source: 'reader',
          occurredAt: '2026-10-24T10:20:00.000Z',
        },
      ],
      '1h',
      '5m',
      now,
    )

    expect(points[0]).toMatchObject({ known: 1, unsure: 0, new: 1 })
    const afterMove = points.find((point) => point.at === '2026-10-24T10:20:00.000Z')
    expect(afterMove).toMatchObject({ known: 0, unsure: 1, new: 1 })
    expect(points.at(-1)).toMatchObject({ known: 0, unsure: 1, new: 1 })
  })

  it('returns no points without events and keeps a single-event range visible', () => {
    expect(buildWordStateTimeline([], '7d', '12h', now)).toEqual([])
    const single = buildWordStateTimeline(
      [
        {
          documentId: 'event:1',
          version: 1,
          id: '1',
          languageCode: 'en',
          lemma: 'a',
          oldStatus: null,
          newStatus: 'known',
          source: 'baseline',
          occurredAt: '2026-10-24T10:59:00.000Z',
        },
      ],
      '1h',
      '5m',
      now,
    )
    expect(single.length).toBeGreaterThan(0)
    expect(single.at(-1)).toMatchObject({ known: 1, unsure: 0, new: 0 })
  })

  it('picks a readable automatic bucket and downsamples dense explicit views', () => {
    expect(autoTimelineBucket('7d', 7 * 24 * 60 * 60 * 1000)).toBe('12h')
    expect(autoTimelineBucket('1h', 60 * 60 * 1000)).toBe('5m')
    const points = Array.from({ length: 500 }, (_, index) => ({
      at: new Date(now - index * 1000).toISOString(),
      known: 1,
      unsure: 0,
      new: 0,
    }))
    expect(downsampleTimeline(points, 40).length).toBeLessThanOrEqual(41)
  })
})
