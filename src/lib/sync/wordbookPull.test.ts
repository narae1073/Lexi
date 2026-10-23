import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import { STORES, idbDelete } from '../storage/localDb'
import { projectionStateKey, readProjectionState, writeProjectionState } from './projectionState'
import {
  PROJECTION_PAGE_MAX,
  projectionPageLimit,
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
  p_updated_since: string | null
  p_limit: number
}

/**
 * PostgREST stand-in for one RPC.
 *
 * `rows` is given in **server order** (the database collation) and the stand-in
 * never sorts: the client must accept the server's order. Resuming by
 * `p_after_lemma` follows the position in that list rather than a JS string
 * comparison, because JS code units do not match a collation.
 */
function projectionServer(rows: ProjectionRow[]) {
  const calls: PageArgs[] = []
  const positions = new Map(rows.map((entry, index) => [entry, index]))

  const client = {
    rpc: async (name: string, args: PageArgs) => {
      calls.push(args)
      if (name !== 'get_wordbook_projection_page') {
        return { data: null, error: { message: `unknown rpc ${name}` } }
      }
      if (args.p_snapshot !== null && args.p_updated_since !== null) {
        return { data: null, error: { message: 'both page bounds were set' } }
      }

      const start =
        args.p_after_lemma === null
          ? -1
          : rows.findIndex(
              (entry) =>
                entry.user_id === USER_ID &&
                entry.language_code === args.p_language_code &&
                entry.lemma === args.p_after_lemma,
            )

      const page = rows
        .filter(
          (entry) =>
            (positions.get(entry) ?? -1) > start &&
            entry.user_id === USER_ID &&
            entry.language_code === args.p_language_code &&
            (args.p_snapshot === null ||
              (entry.server_updated_at <= args.p_snapshot && entry.deleted_at === null)) &&
            (args.p_updated_since === null || entry.server_updated_at > args.p_updated_since),
        )
        .slice(0, args.p_limit)

      return { data: page.map((entry) => ({ ...entry })), error: null }
    },
  }

  return {
    client: client as never,
    calls,
  }
}

function scriptedClient(rows: ProjectionRow[]) {
  return {
    rpc: async () => ({ data: rows.map((entry) => ({ ...entry })), error: null }),
  } as never
}

beforeEach(async () => {
  await idbDelete(STORES.documentMeta, projectionStateKey(USER_ID))
  await idbDelete(STORES.documentMeta, projectionStateKey(OTHER_USER_ID))
})

describe('projection pages', () => {
  it('sends the snapshot, cursor, and null incremental watermark as RPC arguments', async () => {
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
        p_updated_since: null,
        p_limit: 2,
      },
    ])
    expect(page.map((entry) => entry.lemma)).toEqual(['beta', 'delta'])
  })

  it('includes soft-deleted rows in an unbounded incremental page and excludes them from a full page', async () => {
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
    expect(server.calls.at(-1)?.p_updated_since).toBeNull()
  })

  it('bounds an incremental page by the watermark and keeps soft deletes and revivals', async () => {
    const changedAt = '2026-10-27T12:01:00.000Z'
    const deletedAt = '2026-10-27T12:02:00.000Z'
    const revivedAt = '2026-10-27T12:03:00.000Z'

    const server = projectionServer([
      row({ lemma: 'unchanged', server_updated_at: '2026-10-27T11:00:00.000Z' }),
      row({ lemma: 'old-delete', server_updated_at: '2026-10-27T11:30:00.000Z', deleted_at: '2026-10-27T11:30:00.000Z' }),
      row({ lemma: 'changed', server_updated_at: changedAt }),
      row({ lemma: 'deleted', server_updated_at: deletedAt, deleted_at: deletedAt }),
      row({ lemma: 'revived', server_updated_at: revivedAt, deleted_at: null }),
    ])

    const page = await pullProjectionPage(
      server.client,
      USER_ID,
      'fr',
      null,
      null,
      100,
      SNAPSHOT,
    )

    expect(server.calls).toEqual([
      {
        p_language_code: 'fr',
        p_after_lemma: null,
        p_snapshot: null,
        p_updated_since: SNAPSHOT,
        p_limit: 100,
      },
    ])
    expect(page.map((entry) => entry.lemma)).toEqual(['changed', 'deleted', 'revived'])
    expect(page.find((entry) => entry.lemma === 'deleted')?.deleted_at).toBe(deletedAt)
    expect(page.find((entry) => entry.lemma === 'revived')?.deleted_at).toBeNull()
  })

  it('surfaces the server error when a caller passes both bounds', async () => {
    const server = projectionServer([row({ lemma: 'chat' })])

    await expect(
      pullProjectionPage(server.client, USER_ID, 'fr', SNAPSHOT, null, 100, SNAPSHOT),
    ).rejects.toThrow(/both page bounds/)
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
    expect(server.calls.slice(1).every((call) => call.p_snapshot === SNAPSHOT)).toBe(true)
    expect(server.calls.slice(1).every((call) => call.p_after_lemma !== null)).toBe(true)
  })

  const nonAsciiPages: Array<{ name: string; language: string; lemmas: string[] }> = [
    {
      name: 'French collation',
      language: 'fr',
      // äpfel < école < École < étoile < faire < zebra < zèbre < zoo < zulu
      lemmas: ['äpfel', 'école', 'École', 'étoile', 'faire', 'zebra', 'zèbre', 'zoo', 'zulu'],
    },
    {
      name: 'German collation',
      language: 'de',
      lemmas: ['Ähre', 'Ecke', 'Öl', 'Straße', 'über', 'Zebra'],
    },
    {
      name: 'Japanese kana and kanji',
      language: 'ja',
      lemmas: ['あい', 'かさ', 'です', '漢字', '東京'],
    },
  ]

  for (const fixture of nonAsciiPages) {
    it(`resumes a ${fixture.name} page without re-checking collation in JS`, async () => {
      const server = projectionServer(
        fixture.lemmas.map((lemma) =>
          row({ language_code: fixture.language, lemma, surfaces: [lemma] }),
        ),
      )

      const collected: ProjectionRow[] = []
      let cursor: string | null = null
      while (true) {
        const limit = projectionPageLimit(3)
        const page = await pullProjectionPage(
          server.client,
          USER_ID,
          fixture.language,
          SNAPSHOT,
          cursor,
          limit,
        )
        collected.push(...page)
        if (page.length < limit) break
        cursor = page[page.length - 1].lemma
      }

      expect(collected.map((entry) => entry.lemma)).toEqual(fixture.lemmas)
      expect(new Set(collected.map((entry) => entry.lemma)).size).toBe(fixture.lemmas.length)
      // The non-ASCII cursor is the last lemma of each full page exactly.
      const expectedCursors: (string | null)[] = [null]
      for (let start = 0; start + 3 <= fixture.lemmas.length; start += 3) {
        expectedCursors.push(fixture.lemmas[start + 2])
      }
      expect(server.calls.map((call) => call.p_after_lemma)).toEqual(expectedCursors)
    })
  }

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

  it('exposes the effective limit so a clamped page is not mistaken for the end', () => {
    expect(projectionPageLimit(5000)).toBe(PROJECTION_PAGE_MAX)
    expect(projectionPageLimit(PROJECTION_PAGE_MAX)).toBe(PROJECTION_PAGE_MAX)
    expect(projectionPageLimit(100)).toBe(100)
    expect(projectionPageLimit(1)).toBe(1)
    expect(projectionPageLimit(0)).toBe(1)
    expect(projectionPageLimit(-10)).toBe(1)
    expect(projectionPageLimit(Number.POSITIVE_INFINITY)).toBe(PROJECTION_PAGE_MAX)
  })

  it('refuses a page that contains another account row', async () => {
    const client = scriptedClient([row({ user_id: OTHER_USER_ID })])

    await expect(pullProjectionPage(client, USER_ID, 'fr', SNAPSHOT, null, 10)).rejects.toThrow(
      /another account/,
    )
  })

  it('refuses a page for another language instead of cursor-advancing it', async () => {
    const client = scriptedClient([row({ language_code: 'de' })])

    await expect(pullProjectionPage(client, USER_ID, 'fr', SNAPSHOT, null, 10)).rejects.toThrow(
      /language de, expected fr/,
    )
  })

  it('refuses a page that repeats a lemma', async () => {
    const client = scriptedClient([row({ lemma: 'chat' }), row({ lemma: 'chat' })])

    await expect(pullProjectionPage(client, USER_ID, 'fr', SNAPSHOT, null, 10)).rejects.toThrow(
      /repeated lemma chat/,
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
