import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import { useDocumentsStore } from '../../app/stores/documents'
import { useWordStatesStore } from '../../app/stores/wordStates'
import { SUPPORTED_LANGUAGE_CODES } from '../../lib/languages'
import { deleteLocalDatabase, idbGetAll, STORES } from '../../lib/storage/localDb'
import { STARTER_STORIES } from './starterStories'
import {
  dismissFirstRunWelcome,
  readFirstRunRecord,
  resolveFirstRunStories,
  seedFirstRunStories,
} from './firstRun'

beforeEach(async () => {
  await deleteLocalDatabase()
  useDocumentsStore.setState({ documents: [], loading: false, ready: false })
  useWordStatesStore.setState({ byKey: {}, loaded: {} })
})

describe('first-run story seeding', () => {
  it('creates one normal document for every selected language', async () => {
    const record = await seedFirstRunStories(['fr', 'de'])

    expect(record).not.toBeNull()
    const documents = useDocumentsStore.getState().documents
    expect(documents).toHaveLength(2)
    expect(documents.map((doc) => doc.languageCode).sort()).toEqual(['de', 'fr'])
    expect(documents.find((doc) => doc.languageCode === 'fr')?.rawText).toBe(
      STARTER_STORIES.fr.body,
    )
    expect(documents.find((doc) => doc.languageCode === 'fr')?.hasContent).toBe(true)
    expect((await idbGetAll(STORES.wordStates))).toEqual([])
    expect((await idbGetAll(STORES.wordOccurrences))).toEqual([])
  })

  it('records the seeded languages and is idempotent', async () => {
    const first = await seedFirstRunStories(['fr', 'de'])
    const second = await seedFirstRunStories(['fr', 'de'])

    expect(second).toEqual(first)
    expect(useDocumentsStore.getState().documents).toHaveLength(2)
    expect((await readFirstRunRecord())?.documents).toHaveLength(2)
  })

  it('does not seed over an existing library', async () => {
    await useDocumentsStore.getState().create({
      title: 'My own text',
      languageCode: 'en',
      rawText: 'This text was here first.',
      fallbackTitle: 'Untitled',
    })

    expect(await seedFirstRunStories(['fr'])).toBeNull()
    expect(useDocumentsStore.getState().documents).toHaveLength(1)
    expect(await readFirstRunRecord()).toBeUndefined()
  })

  it('keeps only live seeded documents in the welcome list', async () => {
    const record = await seedFirstRunStories(['fr', 'de'])
    const documents = useDocumentsStore.getState().documents

    expect((await resolveFirstRunStories(record!, documents)).map((row) => row.languageCode)).toEqual([
      'fr',
      'de',
    ])
    const live = documents.filter((doc) => doc.languageCode === 'de')
    expect((await resolveFirstRunStories(record!, live)).map((row) => row.languageCode)).toEqual([
      'de',
    ])
  })

  it('keeps every selected language when all eight are chosen', async () => {
    const record = await seedFirstRunStories(SUPPORTED_LANGUAGE_CODES)
    const rows = await resolveFirstRunStories(
      record!,
      useDocumentsStore.getState().documents,
    )

    expect(rows.map((row) => row.languageCode)).toEqual([...SUPPORTED_LANGUAGE_CODES])
    expect(useDocumentsStore.getState().documents).toHaveLength(SUPPORTED_LANGUAGE_CODES.length)
  })

  it('stores a dismissal in the local marker', async () => {
    await seedFirstRunStories(['fr'])
    await dismissFirstRunWelcome()

    expect((await readFirstRunRecord())?.dismissedAt).toEqual(expect.any(String))
  })
})
