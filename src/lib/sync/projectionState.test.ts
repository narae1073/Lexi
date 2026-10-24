import 'fake-indexeddb/auto'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  STORES,
  SYNC_META_KEY,
  idbDelete,
  idbGet,
  idbPut,
  isReservedDocumentMetaId,
} from '../storage/localDb'
import {
  PROJECTION_STATE_KEY_PREFIX,
  emptyProjectionState,
  projectionStateFor,
  projectionStateKey,
  markProjectionFailure,
  readProjectionState,
  updateProjectionState,
  writeProjectionState,
} from './projectionState'
import { memoryServer } from './testMemoryServer'
import { syncOnce } from './sync'
import { readStoredSyncState, writeStoredSyncState } from './syncState'
import type { StoredSyncState } from './types'

/**
 * This project has no jsdom — the R2 regression uses the same localStorage
 * stub as syncState.test.ts.
 */
class MemoryStorage {
  #map = new Map<string, string>()

  getItem(key: string) {
    return this.#map.has(key) ? this.#map.get(key)! : null
  }

  setItem(key: string, value: string) {
    this.#map.set(key, String(value))
  }

  removeItem(key: string) {
    this.#map.delete(key)
  }

  clear() {
    this.#map.clear()
  }

  key(index: number) {
    return [...this.#map.keys()][index] ?? null
  }

  get length() {
    return this.#map.size
  }
}

beforeAll(() => {
  ;(globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage() as unknown as Storage
})

const USER_ID = '00000000-0000-4000-8000-00000000c101'
const OTHER_USER_ID = '00000000-0000-4000-8000-00000000c102'
const SNAPSHOT = '2026-10-27T12:00:00.000Z'
const HYDRATED_AT = '2026-10-27T12:05:00.000Z'

const r2State = (): StoredSyncState => ({
  version: 2,
  pull: { snapshot: '2026-10-26T09:00:00.000Z' },
  push: { documents: '2026-10-26T08:59:00.000Z', wordStates: '2026-10-26T08:58:00.000Z' },
  localEpoch: 'r2-epoch',
})

async function clearProjectionState(userId: string) {
  await idbDelete(STORES.documentMeta, projectionStateKey(userId))
}

beforeEach(async () => {
  localStorage.clear()
  await clearProjectionState(USER_ID)
  await clearProjectionState(OTHER_USER_ID)
  await idbDelete(STORES.documentMeta, SYNC_META_KEY)
})

describe('projection completeness', () => {
  it('treats every enrolled language as incomplete for an R2 device with no projection state', async () => {
    writeStoredSyncState(USER_ID, r2State())

    const state = await readProjectionState(USER_ID)

    expect(state).toEqual({})
    for (const languageCode of ['fr', 'de', 'ja']) {
      expect(projectionStateFor(state, languageCode)).toEqual({
        complete: false,
        snapshot: null,
        cursor: null,
        hydratedAt: null,
      })
    }

    // Becoming R3 must not rewrite the R2 sync state or clear its push
    // watermarks; only a full re-pull of the projection is required.
    expect(readStoredSyncState(USER_ID)).toEqual(r2State())
  })

  it('completes one language without completing another or another account', async () => {
    await writeProjectionState(USER_ID, {
      fr: {
        complete: true,
        snapshot: SNAPSHOT,
        cursor: { languageCode: 'fr', lemma: 'zulu' },
        hydratedAt: HYDRATED_AT,
      },
    })

    const state = await readProjectionState(USER_ID)

    expect(state.fr).toEqual({
      complete: true,
      snapshot: SNAPSHOT,
      cursor: { languageCode: 'fr', lemma: 'zulu' },
      hydratedAt: HYDRATED_AT,
    })
    expect(projectionStateFor(state, 'de')).toEqual(emptyProjectionState())
    expect(await readProjectionState(OTHER_USER_ID)).toEqual({})
  })

  it('keeps the device-local state out of the sync revision and push watermarks', async () => {
    const meta = {
      documentId: SYNC_META_KEY,
      epoch: 'epoch-r2',
      revision: 7,
      pendingByStore: { documents: 2 },
      dirty: { documents: { 'doc-1': 7 } },
    }
    await idbPut(STORES.documentMeta, meta)
    writeStoredSyncState(USER_ID, r2State())

    await writeProjectionState(USER_ID, {
      fr: {
        complete: false,
        snapshot: SNAPSHOT,
        cursor: { languageCode: 'fr', lemma: 'chat' },
        hydratedAt: null,
      },
    })

    expect(await idbGet(STORES.documentMeta, SYNC_META_KEY)).toEqual(meta)
    expect(readStoredSyncState(USER_ID)).toEqual(r2State())

    // The state lives in its own reserved record, never under the sync meta id.
    const stored = await idbGet<{ documentId: string }>(
      STORES.documentMeta,
      projectionStateKey(USER_ID),
    )
    expect(stored?.documentId).toBe(`${PROJECTION_STATE_KEY_PREFIX}${USER_ID}`)
    expect(stored?.documentId).not.toBe(SYNC_META_KEY)
  })
})

describe('projection pause persistence', () => {
  it('restores the pause reason and quota window after a reload', async () => {
    await writeProjectionState(USER_ID, {
      fr: {
        complete: false,
        snapshot: SNAPSHOT,
        cursor: { languageCode: 'fr', lemma: 'chat' },
        hydratedAt: HYDRATED_AT,
        pause: {
          reason: 'quota',
          pausedAt: '2026-10-27T12:01:00.000Z',
          nextAttemptAt: '2026-10-27T12:02:00.000Z',
          quotaBucket: 'page',
          retryAfterSeconds: 60,
        },
      },
    })

    const state = await readProjectionState(USER_ID)
    expect(state.fr).toEqual({
      complete: false,
      snapshot: SNAPSHOT,
      cursor: { languageCode: 'fr', lemma: 'chat' },
      hydratedAt: HYDRATED_AT,
      pause: {
        reason: 'quota',
        pausedAt: '2026-10-27T12:01:00.000Z',
        nextAttemptAt: '2026-10-27T12:02:00.000Z',
        quotaBucket: 'page',
        retryAfterSeconds: 60,
      },
    })
  })

  it('marks only unfinished, resumable languages offline without replacing a reason', async () => {
    await writeProjectionState(USER_ID, {
      fr: {
        complete: false,
        snapshot: SNAPSHOT,
        cursor: { languageCode: 'fr', lemma: 'chat' },
        hydratedAt: null,
      },
      de: {
        complete: true,
        snapshot: SNAPSHOT,
        cursor: null,
        hydratedAt: null,
      },
      ja: {
        complete: false,
        snapshot: null,
        cursor: null,
        hydratedAt: null,
      },
      es: {
        complete: false,
        snapshot: SNAPSHOT,
        cursor: null,
        hydratedAt: null,
        pause: {
          reason: 'quota',
          pausedAt: '2026-10-27T12:01:00.000Z',
          nextAttemptAt: '2026-10-27T12:02:00.000Z',
          quotaBucket: 'page',
          retryAfterSeconds: 60,
        },
      },
    })

    await markProjectionFailure(USER_ID, 'offline')
    const state = await readProjectionState(USER_ID)

    expect(state.fr.pause).toMatchObject({
      reason: 'offline',
      nextAttemptAt: null,
      quotaBucket: null,
      retryAfterSeconds: null,
    })
    expect(state.de.pause).toBeUndefined()
    expect(state.ja.pause).toBeUndefined()
    expect(state.es.pause?.reason).toBe('quota')
  })

  it('drops malformed pause metadata but keeps the resumable cursor', async () => {
    await idbPut(STORES.documentMeta, {
      documentId: projectionStateKey(USER_ID),
      version: 1,
      state: {
        fr: {
          complete: false,
          snapshot: SNAPSHOT,
          cursor: { languageCode: 'fr', lemma: 'chat' },
          hydratedAt: null,
          pause: {
            reason: 'not-a-reason',
            pausedAt: 'yesterday',
            nextAttemptAt: 'tomorrow',
            quotaBucket: 'day',
            retryAfterSeconds: -1,
          },
        },
      },
    })

    const state = await readProjectionState(USER_ID)
    expect(state.fr).toEqual({
      complete: false,
      snapshot: SNAPSHOT,
      cursor: { languageCode: 'fr', lemma: 'chat' },
      hydratedAt: null,
    })
  })

  it('keeps an offline pause before the first page has a snapshot', async () => {
    await writeProjectionState(USER_ID, {
      fr: {
        complete: false,
        snapshot: null,
        cursor: null,
        hydratedAt: null,
        pause: {
          reason: 'offline',
          pausedAt: '2026-10-27T12:01:00.000Z',
          nextAttemptAt: null,
          quotaBucket: null,
          retryAfterSeconds: null,
        },
      },
    })

    const state = await readProjectionState(USER_ID)
    expect(state.fr.pause?.reason).toBe('offline')
    expect(state.fr.snapshot).toBeNull()
    expect(state.fr.cursor).toBeNull()
  })
})

describe('projection cursor persistence', () => {
  it('survives serialization and resume with the snapshot unchanged', async () => {
    await writeProjectionState(USER_ID, {
      fr: {
        complete: false,
        snapshot: SNAPSHOT,
        cursor: { languageCode: 'fr', lemma: 'chat' },
        hydratedAt: null,
      },
    })

    const interrupted = await readProjectionState(USER_ID)
    // A reload hands the map through JSON/structured storage; the cursor and
    // snapshot must come back byte-identical so the pull does not restart.
    const resumed = JSON.parse(JSON.stringify(interrupted)) as typeof interrupted
    expect(resumed.fr.cursor).toEqual({ languageCode: 'fr', lemma: 'chat' })
    expect(resumed.fr.snapshot).toBe(SNAPSHOT)

    resumed.fr.cursor = { languageCode: 'fr', lemma: 'chien' }
    await writeProjectionState(USER_ID, resumed)

    const state = await readProjectionState(USER_ID)
    expect(state.fr.snapshot).toBe(SNAPSHOT)
    expect(state.fr.cursor).toEqual({ languageCode: 'fr', lemma: 'chien' })
    expect(state.fr.complete).toBe(false)
  })

  it('reads a malformed record as an incomplete language instead of resuming past rows', async () => {
    await idbPut(STORES.documentMeta, {
      documentId: projectionStateKey(USER_ID),
      version: 1,
      state: {
        fr: {
          complete: 'yes',
          snapshot: 42,
          cursor: { languageCode: 'de', lemma: 7 },
          hydratedAt: false,
        },
        de: 'not a state',
      },
    })

    const state = await readProjectionState(USER_ID)

    expect(projectionStateFor(state, 'fr')).toEqual(emptyProjectionState())
    expect(projectionStateFor(state, 'de')).toEqual(emptyProjectionState())
  })

  it('treats a record with no usable state object as empty', async () => {
    await idbPut(STORES.documentMeta, {
      documentId: projectionStateKey(USER_ID),
      version: 1,
      state: 'nope',
    })

    expect(await readProjectionState(USER_ID)).toEqual({})
  })
})

describe('atomic projection state updates', () => {
  it('updates one language and preserves every other language', async () => {
    await writeProjectionState(USER_ID, {
      de: {
        complete: true,
        snapshot: '2026-10-27T10:00:00.000Z',
        cursor: { languageCode: 'de', lemma: 'zebra' },
        hydratedAt: '2026-10-27T10:05:00.000Z',
      },
    })

    const next = await updateProjectionState(USER_ID, 'fr', (current) => ({
      ...current,
      snapshot: SNAPSHOT,
      cursor: { languageCode: 'fr', lemma: 'chat' },
    }))

    expect(next).toEqual({
      complete: false,
      snapshot: SNAPSHOT,
      cursor: { languageCode: 'fr', lemma: 'chat' },
      hydratedAt: null,
    })

    const state = await readProjectionState(USER_ID)
    expect(state.de).toEqual({
      complete: true,
      snapshot: '2026-10-27T10:00:00.000Z',
      cursor: { languageCode: 'de', lemma: 'zebra' },
      hydratedAt: '2026-10-27T10:05:00.000Z',
    })
    expect(state.fr).toEqual(next)
  })

  it('does not lose a parallel language write (interleaved update test)', async () => {
    const languages = ['fr', 'de', 'ja', 'es', 'zh']

    await writeProjectionState(USER_ID, {
      fr: {
        complete: false,
        snapshot: SNAPSHOT,
        cursor: { languageCode: 'fr', lemma: 'alpha' },
        hydratedAt: null,
      },
    })

    // Five per-language writers run concurrently. A read-modify-write across
    // two transactions would drop all but the last advanced cursor.
    await Promise.all(
      languages.map((languageCode, index) =>
        updateProjectionState(USER_ID, languageCode, (current) => ({
          ...current,
          snapshot: SNAPSHOT,
          cursor: { languageCode, lemma: `${languageCode}-${index}` },
          complete: languageCode === 'ja',
          hydratedAt: languageCode === 'ja' ? HYDRATED_AT : current.hydratedAt,
        })),
      ),
    )

    const state = await readProjectionState(USER_ID)
    expect(Object.keys(state).sort()).toEqual([...languages].sort())
    for (const [index, languageCode] of languages.entries()) {
      expect(state[languageCode].snapshot).toBe(SNAPSHOT)
      expect(state[languageCode].cursor).toEqual({
        languageCode,
        lemma: `${languageCode}-${index}`,
      })
      expect(state[languageCode].complete).toBe(languageCode === 'ja')
    }
  })

  it('keeps the sync meta record untouched while updating one language', async () => {
    const meta = {
      documentId: SYNC_META_KEY,
      epoch: 'epoch-r2',
      revision: 3,
      pendingByStore: { wordStates: 1 },
      dirty: { wordStates: { 'fr\u0000chat': 3 } },
    }
    await idbPut(STORES.documentMeta, meta)

    await updateProjectionState(USER_ID, 'fr', (current) => ({
      ...current,
      snapshot: SNAPSHOT,
    }))

    expect(await idbGet(STORES.documentMeta, SYNC_META_KEY)).toEqual(meta)
  })

  it('reports an updater failure and leaves the stored state unchanged', async () => {
    await writeProjectionState(USER_ID, {
      fr: {
        complete: false,
        snapshot: SNAPSHOT,
        cursor: { languageCode: 'fr', lemma: 'chat' },
        hydratedAt: null,
      },
    })

    await expect(
      updateProjectionState(USER_ID, 'fr', () => {
        throw new Error('updater failed')
      }),
    ).rejects.toThrow('updater failed')

    expect((await readProjectionState(USER_ID)).fr.cursor).toEqual({
      languageCode: 'fr',
      lemma: 'chat',
    })
  })
})

describe('reserved documentMeta records', () => {
  it('identifies the sync meta and every projection state record as reserved', () => {
    expect(isReservedDocumentMetaId(SYNC_META_KEY)).toBe(true)
    expect(isReservedDocumentMetaId(projectionStateKey(USER_ID))).toBe(true)
    expect(isReservedDocumentMetaId(projectionStateKey(OTHER_USER_ID))).toBe(true)
    expect(isReservedDocumentMetaId('2c7f0a8e-0000-4000-8000-000000000001')).toBe(false)
    expect(isReservedDocumentMetaId(undefined)).toBe(false)
  })

  it('survives a sync cycle and is never mistaken for a document meta row', async () => {
    await writeProjectionState(USER_ID, {
      fr: {
        complete: false,
        snapshot: SNAPSHOT,
        cursor: { languageCode: 'fr', lemma: 'chat' },
        hydratedAt: null,
      },
    })

    const server = memoryServer()
    await syncOnce({ userId: USER_ID, languages: ['fr'], db: server.client })

    const stored = await idbGet<{ documentId: string }>(
      STORES.documentMeta,
      projectionStateKey(USER_ID),
    )
    expect(stored).toBeDefined()
    expect(isReservedDocumentMetaId(stored?.documentId)).toBe(true)
    // Task 8 owns this record: a sync may complete the language (empty
    // projection) and clear the cursor. What must survive is the account's
    // entry and its snapshot, never a rewrite as a document row.
    expect((await readProjectionState(USER_ID)).fr.snapshot).toBeDefined()
  })
})
