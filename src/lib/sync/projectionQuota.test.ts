import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import { deleteLocalDatabase } from '../storage/localDb'
import { pull } from './pull'
import { ProjectionQuotaError } from './wordbookPull'
import type { ProjectionRow } from './wordbookPull'
import { memoryServer, type Server } from './testMemoryServer'

const USER_ID = '00000000-0000-4000-8000-00000000e201'

function projectionRow(lemma: string, language = 'fr'): ProjectionRow {
  return {
    user_id: USER_ID,
    language_code: language,
    lemma,
    surfaces: [lemma],
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
    server_updated_at: '2026-10-29T00:00:00.000Z',
  }
}

function lemma(index: number): string {
  return `w${String(index).padStart(4, '0')}`
}

type PageCall = {
  after: string | null
  snapshot: string | null
  updatedSince: string | null
}

/**
 * A client that fails the nth projection page with a Supabase-shaped quota
 * error, while recording every page request.
 */
function quotaAfter(
  server: Server,
  failOnCall: number,
  bucket: 'page' | 'sync',
) {
  const base = server.client as unknown as {
    rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>
  }
  const calls: PageCall[] = []
  const rpcNames: string[] = []
  let pageCalls = 0

  const client = {
    ...(server.client as unknown as Record<string, unknown>),
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcNames.push(name)
      if (
        name === 'get_wordbook_projection_page' ||
        name === 'get_wordbook_projection_page_bounded'
      ) {
        pageCalls += 1
        calls.push({
          after: (args.p_after_lemma as string | null) ?? null,
          snapshot: (args.p_snapshot as string | null) ?? null,
          updatedSince: (args.p_updated_since as string | null) ?? null,
        })
        if (pageCalls === failOnCall) {
          return {
            data: null,
            error: {
              code: 'PT429',
              details: `bucket=${bucket};retry_after_seconds=42`,
              message: 'projection quota exceeded',
            },
          }
        }
      }
      return base.rpc(name, args)
    },
  }

  return { client: client as never, calls, rpcNames }
}

beforeEach(async () => {
  await deleteLocalDatabase()
})

describe('quota-aware projection pulls', () => {
  it('stores the pages read before a denial and resumes from their cursor', async () => {
    const server = memoryServer()
    for (let index = 1; index <= 1500; index += 1) {
      server.add('wordbook_entries', projectionRow(lemma(index)))
    }

    const first = quotaAfter(server, 2, 'page')
    const paused = await pull(USER_ID, first.client, {}, { languages: ['fr'] })

    // Page 1 was read and is returned to be stored; page 2 was denied.
    expect(paused.wordbookEntries.map((row) => row.lemma)).toEqual(
      Array.from({ length: 1000 }, (_, index) => lemma(index + 1)),
    )
    expect(first.calls).toHaveLength(2)
    // The 429 is recorded in a separate request because the denied page's own
    // counter rolled back with its exception.
    expect(first.rpcNames).toContain('consume_projection_quota')
    expect(paused.projection.paused).toContain('fr')
    expect(paused.projection.pauseReason).toBe('quota')
    expect(paused.projection.quota).toEqual({ bucket: 'page', retryAfterSeconds: 42 })
    // Page 1 starts the pass and carries rows, so the language is cleared now
    // and the cursor is the resume point.
    expect(paused.projection.reset).toContain('fr')
    expect(paused.projection.next.fr.complete).toBe(false)
    expect(paused.projection.next.fr.snapshot).not.toBeNull()
    expect(paused.projection.next.fr.cursor).toEqual({
      languageCode: 'fr',
      lemma: lemma(1000),
    })
    expect(paused.projection.next.fr.pause).toMatchObject({
      reason: 'quota',
      quotaBucket: 'page',
      retryAfterSeconds: 42,
    })
    expect(paused.projection.next.fr.pause?.pausedAt).toEqual(expect.any(String))
    expect(paused.projection.next.fr.pause?.nextAttemptAt).toEqual(expect.any(String))

    // The next cycle resumes after the last stored lemma, not from lemma 0.
    // Move the persisted quota window into the past so this test covers the
    // resume page shape; the waiting behavior has its own test below.
    if (paused.projection.next.fr.pause) {
      paused.projection.next.fr.pause.nextAttemptAt = new Date(Date.now() - 1).toISOString()
    }
    const resumed = quotaAfter(server, 0, 'page')
    const rest = await pull(
      USER_ID,
      resumed.client,
      {},
      { languages: ['fr'], projectionState: paused.projection.next },
    )

    expect(resumed.calls[0]).toEqual({
      after: lemma(1000),
      snapshot: paused.projection.next.fr.snapshot,
      updatedSince: null,
    })
    expect(rest.wordbookEntries.map((row) => row.lemma)).toEqual(
      Array.from({ length: 500 }, (_, index) => lemma(index + 1001)),
    )
    expect(rest.projection.next.fr.complete).toBe(true)
    expect(rest.projection.paused).toEqual([])
    expect(rest.projection.pauseReason).toBeNull()
  })

  it('does not resume a paused pass without consent', async () => {
    const server = memoryServer()
    for (let index = 1; index <= 1500; index += 1) {
      server.add('wordbook_entries', projectionRow(lemma(index)))
    }

    const first = quotaAfter(server, 2, 'page')
    const paused = await pull(USER_ID, first.client, {}, { languages: ['fr'] })
    const denied = quotaAfter(server, 0, 'page')
    const blocked = await pull(USER_ID, denied.client, {}, {
      languages: ['fr'],
      projectionState: paused.projection.next,
      resumePaused: false,
    })

    expect(denied.calls).toHaveLength(0)
    expect(blocked.wordbookEntries).toEqual([])
    expect(blocked.projection.next).toEqual({})
  })

  it('waits for a persisted quota window even when resume is allowed', async () => {
    const server = memoryServer()
    server.add('wordbook_entries', projectionRow(lemma(1)))
    const state = {
      fr: {
        complete: false,
        snapshot: '2026-10-30T00:00:00.000Z',
        cursor: null,
        hydratedAt: null,
        pause: {
          reason: 'quota' as const,
          pausedAt: new Date().toISOString(),
          nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
          quotaBucket: 'page' as const,
          retryAfterSeconds: 60,
        },
      },
    }
    const waiting = quotaAfter(server, 0, 'page')
    const result = await pull(USER_ID, waiting.client, {}, {
      languages: ['fr'],
      projectionState: state,
      resumePaused: true,
    })

    expect(waiting.calls).toHaveLength(0)
    expect(result.wordbookEntries).toEqual([])
  })

  it('does not clear a language when a new pass is denied before its first page', async () => {
    const server = memoryServer()
    for (let index = 1; index <= 5; index += 1) {
      server.add('wordbook_entries', projectionRow(lemma(index)))
    }

    const denied = quotaAfter(server, 1, 'sync')
    const result = await pull(USER_ID, denied.client, {}, { languages: ['fr'] })

    expect(result.wordbookEntries).toEqual([])
    expect(result.projection.paused).toContain('fr')
    expect(result.projection.pauseReason).toBe('quota')
    expect(result.projection.quota).toEqual({ bucket: 'sync', retryAfterSeconds: 42 })
    // Nothing was read, so the local wordbook must not be emptied for an empty
    // download. The charged snapshot is retained so the next cycle resumes the
    // same pass without another daily unit; the language is cleared only once
    // it can actually download it.
    expect(result.projection.reset).toEqual([])
    expect(result.projection.next.fr.snapshot).not.toBeNull()
    expect(result.projection.next.fr.cursor).toBeNull()
    expect(result.projection.next.fr.complete).toBe(false)
  })

  it('exposes the denial as a typed, recoverable client error', async () => {
    const server = memoryServer()
    const denied = quotaAfter(server, 1, 'page')
    const { pullProjectionPage } = await import('./wordbookPull')

    const failure = await pullProjectionPage(
      denied.client,
      USER_ID,
      'fr',
      '2026-10-30T00:00:00.000Z',
      null,
      10,
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ProjectionQuotaError)
    expect((failure as ProjectionQuotaError).recoverable).toBe(true)
  })

  it('resets a language whose server cursor state no longer matches', async () => {
    const server = memoryServer()
    for (let index = 1; index <= 1500; index += 1) {
      server.add('wordbook_entries', projectionRow(lemma(index)))
    }

    const base = server.client as unknown as {
      rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>
    }
    let pageCalls = 0
    const client = {
      ...(server.client as unknown as Record<string, unknown>),
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (
          name === 'get_wordbook_projection_page' ||
          name === 'get_wordbook_projection_page_bounded'
        ) {
          pageCalls += 1
          if (pageCalls === 2) {
            return {
              data: null,
              error: {
                code: 'PT409',
                details: 'reason=cursor',
                message: 'projection cursor does not match this pass',
              },
            }
          }
        }
        return base.rpc(name, args)
      },
    }

    const result = await pull(USER_ID, client as never, {}, { languages: ['fr'] })

    expect(result.projection.pauseReason).toBe('state')
    expect(result.projection.paused).toContain('fr')
    expect(result.projection.quota).toBeNull()
    // Restart the same charged snapshot from lemma 0 instead of retrying the
    // rejected cursor. A new snapshot would spend another daily unit.
    expect(result.projection.next.fr).toMatchObject({
      complete: false,
      snapshot: '2026-10-30T00:00:00.000Z',
      cursor: null,
      hydratedAt: null,
      pause: {
        reason: 'state',
        quotaBucket: null,
        retryAfterSeconds: null,
      },
    })
  })
})
