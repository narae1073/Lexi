import 'fake-indexeddb/auto'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { STORES, SYNC_META_KEY, idbDelete, idbGet, idbPut } from '../storage/localDb'
import {
  PROJECTION_STATE_KEY_PREFIX,
  emptyProjectionState,
  projectionStateFor,
  projectionStateKey,
  readProjectionState,
  writeProjectionState,
} from './projectionState'
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
