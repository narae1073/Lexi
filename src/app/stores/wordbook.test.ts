import { beforeEach, describe, expect, it } from 'vitest'

import type { WordState } from '../../types'
import type { ProjectionWordbookEntry } from '../../features/wordbook/wordbookProjection'
import { useWordbookStore } from './wordbook'

const baseEntry = {
  languageCode: 'en',
  lemma: 'cat',
  surfaces: ['cat'],
  status: 'known',
  favorite: false,
  starColor: '#eab308',
  starAngle: 0,
  sentence: '',
  documentId: '',
  documentTitle: '',
  contexts: [],
  lastSeenAt: '',
  knownPresses: 0,
  note: undefined,
  count: 1,
  documentCount: 1,
} as ProjectionWordbookEntry

const state: WordState = {
  languageCode: 'en',
  lemma: 'cat',
  status: 'known',
  seenCount: 1,
  firstSeenAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  favorite: true,
  starAngle: 17,
  starColor: '#ef4444',
  knownPresses: 0,
  unsurePresses: 0,
  unknownPresses: 0,
}

beforeEach(() => {
  useWordbookStore.setState({ entriesByLanguage: { en: [baseEntry] } })
})

describe('wordbook store state patches', () => {
  it('updates the star angle together with the favorite color', () => {
    useWordbookStore.getState().applyWordStates([
      { languageCode: 'en', lemma: 'cat', state },
    ])

    expect(useWordbookStore.getState().entriesByLanguage.en?.[0]).toMatchObject({
      favorite: true,
      starColor: '#ef4444',
      starAngle: 17,
    })
  })
})
