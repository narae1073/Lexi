import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import { STORES, idbDelete } from '../storage/localDb'
import { projectionStateKey, readProjectionState, writeProjectionState } from './projectionState'
import {
  PROJECTION_PAGE_MAX,
  pullProjectionPage,
} from './wordbookPull'
import type { ProjectionRow } from './wordbookPull'

const USER_ID = '00000000-0000-4000-8000-00000000d101'
const OTHER_USER_ID = '00000000-0000-4000-8000-00000000d102'
const SNAPSHOT = '2026-10-27T12:00:00.000Z'

function row(over: Partial<ProjectionRow> = {}): ProjectionRow {
  return {
    user_id: USER_ID,
    language_code: 'fr',
    lemma: 'chat',
    surfaces: ['chat'],
    contexts: [],
    occurrence_count: 1,
    document_count: 1,
    status: null,
    is_favorite: false,
    star_angle: 0,
    star_color: '#eab308',
    seen_count: 1,
    first_seen_at: null,
    last_seen_at: null,
    favorite_updated_at: null,
    known_presses: 0,
    unsure_presses: 0,
    unknown_presses: 0,
    note: null,
    note_updated_at: null,
    deleted_at: null,
    server_updated_at: SNAPSHOT,
    ...over,
  }
}

type PageArgs = {
  p_language_code: string
  p_after_lemma: string | null
  p_snapshot: string | null
  p_limit: number
}

/**
 * PostgREST stand-in for one RPC. It applies the same rules as the SQL
 * function: caller's rows only, one language, keyset by lemma, a snapshot
 * upper bound for a full pull, and live rows only while the snapshot bound is
 * present (incremental mode includes soft deletions).
 */
function projectionServer(rows: ProjectionRow[]) {
  const calls: PageArgs[] = []

  const client = {
    rpc: async (name: string, args: PageArgs) => {
      calls.push(args)
      if (name !== 'get_wordbook_projection_page') {
        return { data: null, error: { message: `unknown rpc ${name}` } }
      }
      let page = rows.filter(
        (entry) =>
          entry.user_id === USER_ID &&
          entry.language_code === args.p_language_code &&
          (args.p_after_lemma === null || entry.lemma > args.p_after_lemma) &&
          (args.p_snapshot === null ||
            (entry.server_updated_at <= args.p_snapshot && entry.deleted_at === null)),
      )
      page = [...page].sort((a, b) => a.lemma.localeCompare(b.lemma))
      return { data: page.slice(0, args.p_limit).map((entry) => ({ ...entry })), error: null }
    },
  }

  return {
    client: client as never,
    calls,
  }
}

function unorderedClient(rows: ProjectionRow[]) {
  return {
    rpc: async () => ({ data: rows.map((entry) => ({ ...entry })), error: null }),
  } as never
}

beforeEach(async () => {
  await idbDelete(STORES.documentMeta, projectionStateKey(USER_ID))
  await idbDelete(STORES.documentMeta, projectionStateKey(OTHER_USER_ID))
})

describe('projection pages', () => {
  it('sends the snapshot and cursor as RPC arguments and returns the page', async () => {
    const server = projectionServer([
      row({ lemma: 'alpha' }),
      row({ lemma: 'beta' }),
      row({ lemma: 'delta' }),
    ])

    const page = await pullProjectionPage(server.client, USER_ID, 'fr', SNAPSHOT, 'alpha', 2)

    expect(server.calls).toEqual([
      {
        p_language_code: 'fr',
        p_after_lemma: 'alpha',
        p_snapshot: SNAPSHOT,
        p_limit: 2,
      },
    ])
    expect(page.map((entry) => entry.lemma)).toEqual(['beta', 'delta'])
  })

  it('includes soft-deleted rows in incremental mode and excludes them from a full page', async () => {
    const server = projectionServer([
      row({ lemma: 'chat' }),
      row({ lemma: 'chien', deleted_at: '2026-10-27T12:03:00.000Z' }),
    ])

    const full = await pullProjectionPage(server.client, USER_ID, 'fr', SNAPSHOT, null, 100)
    expect(full.map((entry) => entry.lemma)).toEqual(['chat'])

    const incremental = await pullProjectionPage(server.client, USER_ID, 'fr', null, null, 100)
    expect(incremental.map((entry) => entry.lemma)).toEqual(['chat', 'chien'])
    expect(incremental.find((entry) => entry.lemma === 'chien')?.deleted_at).toBe(
      '2026-10-27T12:03:00.000Z',
    )
  })

  it('resumes past an interruption without duplicating or skipping a lemma', async () => {
    const server = projectionServer([
      row({ lemma: 'alpha' }),
      row({ lemma: 'beta' }),
      row({ lemma: 'delta' }),
      row({ lemma: 'gamma' }),
      row({ lemma: 'omega' }),
      // Changed after the snapshot: not part of this full pull.
      row({ lemma: 'after-snapshot', server_updated_at: '2026-10-27T12:00:01.000Z' }),
      // Already dead before the snapshot: absent from the full pull.
      row({ lemma: 'beta-dead', deleted_at: '2026-10-27T11:59:00.000Z' }),
    ])

    const first = await pullProjectionPage(server.client, USER_ID, 'fr', SNAPSHOT, null, 2)
    expect(first.map((entry) => entry.lemma)).toEqual(['alpha', 'beta'])

    // Persist snapshot + cursor together, then "reload" before the next page.
    await writeProjectionState(USER_ID, {
      fr: {
        complete: false,
        snapshot: SNAPSHOT,
        cursor: { languageCode: 'fr', lemma: first[first.length - 1].lemma },
        hydratedAt: null,
      },
    })
    const resumed = await readProjectionState(USER_ID)
    expect(resumed.fr.snapshot).toBe(SNAPSHOT)

    const collected = [...first]
    let cursor = resumed.fr.cursor?.lemma ?? null
    while (cursor !== null) {
      const page = await pullProjectionPage(server.client, USER_ID, 'fr', SNAPSHOT, cursor, 2)
      collected.push(...page)
      cursor = page.length === 2 ? page[page.length - 1].lemma : null
    }

    expect(collected.map((entry) => entry.lemma)).toEqual([
      'alpha',
      'beta',
      'delta',
      'gamma',
      'omega',
    ])
    expect(new Set(collected.map((entry) => entry.lemma)).size).toBe(collected.length)
    // Every page after the first used the resumed cursor, never a reset cursor.
    expect(server.calls.slice(1).every((call) => call.p_snapshot === SNAPSHOT)).toBe(true)
    expect(server.calls.slice(1).every((call) => call.p_after_lemma !== null)).toBe(true)
  })

  it('clamps the page size to the server maximum', async () => {
    const server = projectionServer([])

    await pullProjectionPage(server.client, USER_ID, 'fr', SNAPSHOT, null, 5000)
    await pullProjectionPage(server.client, USER_ID, 'fr', SNAPSHOT, null, 0)
    await pullProjectionPage(server.client, USER_ID, 'fr', SNAPSHOT, null, -3)
    await pullProjectionPage(server.client, USER_ID, 'fr', SNAPSHOT, null, 12.9)

    expect(server.calls.map((call) => call.p_limit)).toEqual([
      PROJECTION_PAGE_MAX,
      1,
      1,
      12,
    ])
  })

  it('refuses a page that contains another account row', async () => {
    const client = {
      rpc: async () => ({ data: [row({ user_id: OTHER_USER_ID })], error: null }),
    } as never

    await expect(pullProjectionPage(client, USER_ID, 'fr', SNAPSHOT, null, 10)).rejects.toThrow(
      /another account/,
    )
  })

  it('refuses an unordered page instead of advancing a skip-prone cursor', async () => {
    const client = unorderedClient([
      row({ lemma: 'zulu' }),
      row({ lemma: 'alpha' }),
    ])

    await expect(pullProjectionPage(client, USER_ID, 'fr', SNAPSHOT, null, 10)).rejects.toThrow(
      /order/,
    )
  })

  it('surfaces the RPC error instead of returning a partial page', async () => {
    const client = {
      rpc: async () => ({ data: null, error: { message: 'projection page failed' } }),
    } as never

    await expect(pullProjectionPage(client, USER_ID, 'fr', SNAPSHOT, null, 10)).rejects.toThrow(
      'projection page failed',
    )
  })
})
