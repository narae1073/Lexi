import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import { STORES, idbDelete, idbGetAll } from '../storage/localDb'
import { memoryServer } from './testMemoryServer'
import { syncOnce } from './sync'

const USER_ID = 'user-1'
const SNAPSHOT = '2026-10-30T00:00:00.000Z'

function serverWord(lemma: string, id: string, updatedAt = SNAPSHOT) {
  return {
    id,
    user_id: USER_ID,
    language_code: 'fr',
    lemma,
    status: 'known',
    seen_count: 1,
    first_seen_at: updatedAt,
    last_seen_at: updatedAt,
    is_favorite: false,
    favorite_updated_at: updatedAt,
    star_angle: 0,
    star_color: '#eab308',
    known_presses: 0,
    unsure_presses: 0,
    unknown_presses: 0,
    note: null,
    note_updated_at: null,
    server_updated_at: updatedAt,
  }
}

async function sync(server: ReturnType<typeof memoryServer>, since?: { snapshot?: string }) {
  return syncOnce({ userId: USER_ID, languages: ['fr'], db: server.client, since })
}

beforeEach(async () => {
  for (const row of await idbGetAll<{ languageCode: string; lemma: string }>(STORES.wordStates)) {
    await idbDelete(STORES.wordStates, [row.languageCode, row.lemma])
  }
})

describe('snapshot-based pulls', () => {
  it('uses one snapshot and excludes rows inserted after it', async () => {
    const server = memoryServer(1000, SNAPSHOT)
    for (let index = 0; index < 1000; index++) {
      server.add('word_states', serverWord(`seed-${String(index).padStart(4, '0')}`, `ws-${index}`))
    }

    let inserted = false
    server.afterPage((table, page) => {
      if (table === 'word_states' && page === 1 && !inserted) {
        inserted = true
        server.add('word_states', serverWord('inserted-after-snapshot', 'ws-after', '2026-10-30T00:00:01.000Z'))
      }
    })

    const first = await sync(server)
    expect(inserted).toBe(true)
    expect(server.rpcCalls('sync_snapshot')).toBe(1)
    expect(first.pulled).toBe(1000)
    expect(first.watermarks.snapshot).toBe(SNAPSHOT)
    expect(
      (await idbGetAll<{ lemma: string }>(STORES.wordStates)).some(
        (row) => row.lemma === 'inserted-after-snapshot',
      ),
    ).toBe(false)

    server.afterPage(undefined)
    const nextSnapshot = '2026-10-30T00:01:00.000Z'
    server.setSnapshot(nextSnapshot)
    const second = await sync(server, first.watermarks)

    expect(server.rpcCalls('sync_snapshot')).toBe(2)
    expect(second.pulled).toBe(1)
    expect(second.watermarks.snapshot).toBe(nextSnapshot)
    const local = await idbGetAll<{ lemma: string }>(STORES.wordStates)
    expect(local.filter((row) => row.lemma === 'inserted-after-snapshot')).toHaveLength(1)
  }, 20_000)

  it('returns the unadjusted new snapshot as the next pull watermark', async () => {
    const server = memoryServer(1000, SNAPSHOT)

    const report = await sync(server)

    expect(report.watermarks.snapshot).toBe(SNAPSHOT)
    expect(report.watermarks.snapshot).not.toBe(
      new Date(Date.parse(SNAPSHOT) - 5 * 60_000).toISOString(),
    )
    expect(server.rpcCalls('sync_snapshot')).toBe(1)
  })

  it('re-reads the five-minute overlap after a late commit', async () => {
    const server = memoryServer(1000, SNAPSHOT)
    const first = await sync(server)
    const lateCommitTime = new Date(Date.parse(SNAPSHOT) - 60_000).toISOString()
    server.add('word_states', serverWord('late-commit', 'ws-late', lateCommitTime))
    const nextSnapshot = '2026-10-30T00:01:00.000Z'
    server.setSnapshot(nextSnapshot)

    const second = await sync(server, first.watermarks)

    expect(second.pulled).toBe(1)
    expect(second.watermarks.snapshot).toBe(nextSnapshot)
    expect((await idbGetAll<{ lemma: string }>(STORES.wordStates)).filter((row) => row.lemma === 'late-commit'))
      .toHaveLength(1)
    expect(server.rpcCalls('sync_snapshot')).toBe(2)
  })
})
