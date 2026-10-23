import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  STORES,
  deleteLocalDatabase,
  ensureLocalSyncMeta,
  idbGetAll,
  idbPut,
  onLocalWrite,
  readLocalSyncMeta,
  type StoreName,
} from '../../lib/storage/localDb'
import { syncOnce } from '../../lib/sync/sync'
import { memoryServer } from '../../lib/sync/testMemoryServer'
import type { ProjectionRow } from '../../lib/sync/wordbookPull'
import { useSyncStore } from './sync'

const USER_ID = '00000000-0000-4000-8000-00000000f101'
/** A snapshot in the past: push watermarks compare against the client clock. */
const SNAPSHOT = new Date(Date.now() - 60 * 60_000).toISOString()
const OLDER_SNAPSHOT = new Date(Date.parse(SNAPSHOT) - 24 * 60 * 60_000).toISOString()

function projectionRow(over: Partial<ProjectionRow> = {}): ProjectionRow {
  return {
    user_id: USER_ID,
    language_code: 'fr',
    lemma: 'chat',
    surfaces: ['chat'],
    contexts: [{ documentId: 'doc-1', sentence: 'Le chat dort.' }],
    occurrence_count: 3,
    document_count: 1,
    status: 'known',
    is_favorite: true,
    star_angle: 15,
    star_color: '#ef4444',
    seen_count: 4,
    first_seen_at: OLDER_SNAPSHOT,
    last_seen_at: OLDER_SNAPSHOT,
    favorite_updated_at: OLDER_SNAPSHOT,
    known_presses: 2,
    unsure_presses: 0,
    unknown_presses: 1,
    note: 'server note',
    note_updated_at: OLDER_SNAPSHOT,
    deleted_at: null,
    server_updated_at: SNAPSHOT,
    ...over,
  }
}

beforeEach(async () => {
  await deleteLocalDatabase()
  useSyncStore.setState({
    status: 'local',
    error: null,
    dirty: false,
    pendingByStore: {},
    report: null,
  })
})

describe('silent word-state hydration from the projection', () => {
  it('fills word states without a pending count, dirty key, or local-write signal', async () => {
    const server = memoryServer(1000, SNAPSHOT)
    server.add('wordbook_entries', projectionRow())
    server.add('wordbook_entries', projectionRow({ lemma: 'chien', status: 'unsure' }))
    await ensureLocalSyncMeta()

    const writes: StoreName[] = []
    const off = onLocalWrite((store) => writes.push(store))
    try {
      const report = await syncOnce({
        userId: USER_ID,
        languages: ['fr'],
        db: server.client,
      })

      const states = await idbGetAll<Record<string, unknown>>(STORES.wordStates)
      expect(states.map((row) => row.lemma).sort()).toEqual(['chat', 'chien'])
      expect(states.find((row) => row.lemma === 'chat')).toMatchObject({
        status: 'known',
        favorite: true,
        starAngle: 15,
        starColor: '#ef4444',
        seenCount: 4,
        knownPresses: 2,
        unknownPresses: 1,
        note: 'server note',
      })

      // Hydration is a copy of server data, not local work.
      expect(writes).toEqual([])
      expect(await readLocalSyncMeta()).toMatchObject({
        revision: 0,
        pendingByStore: {},
        dirty: {},
      })
      expect(useSyncStore.getState().pendingByStore).toEqual({})
      expect(useSyncStore.getState().dirty).toBe(false)

      expect(report.pulled).toBe(2)
      expect(report.pushed).toBe(0)
      // The wordbook report counts what is on the device after hydration, not
      // the empty word_state table it started from.
      expect(report.localWords).toBe(2)
      // The word-state push watermark is initialized to the projection cycle,
      // so the rows this device just downloaded are not sent back.
      expect(Date.parse(report.pushWatermarks.wordStates ?? '')).toBeGreaterThanOrEqual(
        Date.parse(SNAPSHOT),
      )
    } finally {
      off()
    }
  })

  it('does not push hydrated rows on the next cycle', async () => {
    const server = memoryServer(1000, SNAPSHOT)
    server.add('wordbook_entries', projectionRow())
    server.add('wordbook_entries', projectionRow({ lemma: 'chien' }))

    const first = await syncOnce({ userId: USER_ID, languages: ['fr'], db: server.client })
    const upsertsBefore = server.upsertCalls('word_states')
    expect(first.pushed).toBe(0)

    const second = await syncOnce({
      userId: USER_ID,
      languages: ['fr'],
      db: server.client,
      since: first.watermarks,
      push: first.pushWatermarks,
    })

    expect(second.pushed).toBe(0)
    expect(server.upsertCalls('word_states')).toBe(upsertsBefore)
    expect(await idbGetAll<Record<string, unknown>>(STORES.wordStates)).toHaveLength(2)
  })

  it('does not raise the word-state watermark over a failed push', async () => {
    const server = memoryServer(1000, SNAPSHOT)
    // A projection row makes hydration happen in this cycle.
    server.add('wordbook_entries', projectionRow())
    // A clean local row selected only by its timestamp: it has no dirty key,
    // so raising the watermark past it would strand it forever.
    await idbPut(
      STORES.wordStates,
      {
        languageCode: 'fr',
        lemma: 'chien',
        status: 'unsure',
        seenCount: 1,
        firstSeenAt: SNAPSHOT,
        lastSeenAt: SNAPSHOT,
        favorite: false,
        starAngle: 0,
        starColor: '#eab308',
        knownPresses: 0,
        unsurePresses: 0,
        unknownPresses: 0,
      },
      { silent: true },
    )
    server.rejectUpsert('word_states', () => true)

    const first = await syncOnce({
      userId: USER_ID,
      languages: ['fr'],
      db: server.client,
      push: { wordStates: OLDER_SNAPSHOT },
    })

    expect(first.failures.some((failure) => failure.table === 'wordStates')).toBe(true)
    // Hydration happened, but the failed table keeps its watermark.
    expect(first.pushWatermarks.wordStates).toBe(OLDER_SNAPSHOT)
    expect((await readLocalSyncMeta())?.dirty.wordStates).toBeUndefined()

    server.rejectUpsert('word_states', null)
    await syncOnce({
      userId: USER_ID,
      languages: ['fr'],
      db: server.client,
      since: first.watermarks,
      push: first.pushWatermarks,
    })

    // The timestamp-selected row is retried and reaches the server.
    expect(server.rows('word_states').some((row) => row.lemma === 'chien')).toBe(true)
  })

  it('still lets a local edit after hydration be pushed', async () => {
    const server = memoryServer(1000, SNAPSHOT)
    server.add('wordbook_entries', projectionRow())

    const first = await syncOnce({ userId: USER_ID, languages: ['fr'], db: server.client })
    expect(first.pushed).toBe(0)

    // A user edit after the projection landed — the journal, not a timestamp,
    // is what makes it eligible even though the watermark is newer.
    await idbPut(STORES.wordStates, {
      languageCode: 'fr',
      lemma: 'chat',
      status: 'unknown',
      seenCount: 5,
      firstSeenAt: OLDER_SNAPSHOT,
      lastSeenAt: SNAPSHOT,
      favorite: true,
      favoriteUpdatedAt: OLDER_SNAPSHOT,
      starAngle: 15,
      starColor: '#ef4444',
      knownPresses: 2,
      unsurePresses: 0,
      unknownPresses: 1,
      note: 'server note',
      noteUpdatedAt: OLDER_SNAPSHOT,
    })

    const second = await syncOnce({
      userId: USER_ID,
      languages: ['fr'],
      db: server.client,
      since: first.watermarks,
      push: first.pushWatermarks,
    })

    expect(second.pushed).toBe(1)
    expect(
      server.rows('word_states').find((row) => row.lemma === 'chat')?.status,
    ).toBe('unknown')
  })
})
