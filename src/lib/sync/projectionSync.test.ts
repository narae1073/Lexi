import 'fake-indexeddb/auto'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  STORES,
  deleteLocalDatabase,
  idbGetAll,
  idbPut,
} from '../storage/localDb'
import {
  deleteWordbookEntry,
  putWordbookEntries,
  readWordbookEntries,
} from '../storage/wordbookEntries'
import type { WordbookEntryInput } from '../storage/wordbookEntries'
import type { Document } from '../../types'
import type { WordOccurrence } from '../../app/stores/occurrences'
import { pullProjectionPage } from './wordbookPull'
import type { ProjectionRow } from './wordbookPull'
import {
  projectionStateFor,
  readProjectionState,
  writeProjectionState,
} from './projectionState'
import { syncOnce } from './sync'
import { readStoredSyncState, writeStoredSyncState } from './syncState'
import type { StoredSyncState } from './types'
import { memoryServer, type Server } from './testMemoryServer'

const USER_ID = '00000000-0000-4000-8000-00000000e101'
/** A snapshot in the past: push watermarks compare against the client clock. */
const SNAPSHOT = new Date(Date.now() - 60 * 60_000).toISOString()
const OLDER_SNAPSHOT = new Date(Date.parse(SNAPSHOT) - 24 * 60 * 60_000).toISOString()
/** Older than the five-minute overlap of an incremental pull from OLDER_SNAPSHOT. */
const CONTENT_SNAPSHOT = new Date(Date.parse(OLDER_SNAPSHOT) - 60 * 60_000).toISOString()
/** Changed after OLDER_SNAPSHOT but before the cycle snapshot. */
const CHANGED_AT = new Date(Date.parse(OLDER_SNAPSHOT) + 60_000).toISOString()
const R2_PULL = new Date(Date.parse(SNAPSHOT) - 48 * 60 * 60_000).toISOString()
/** Incremental reads start five minutes before the stored completion snapshot. */
function incrementalSince(snapshot: string): string {
  return new Date(Date.parse(snapshot) - 5 * 60_000).toISOString()
}

/** This project has no jsdom; the R2 state tests use the same localStorage stub. */
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

function projectionRow(over: Partial<ProjectionRow> = {}): ProjectionRow {
  return {
    user_id: USER_ID,
    language_code: 'fr',
    lemma: 'chat',
    surfaces: ['chat'],
    contexts: [{ documentId: 'doc-1', sentence: 'Le chat dort.' }],
    occurrence_count: 2,
    document_count: 1,
    status: 'known',
    is_favorite: false,
    star_angle: 0,
    star_color: '#eab308',
    seen_count: 2,
    first_seen_at: OLDER_SNAPSHOT,
    last_seen_at: OLDER_SNAPSHOT,
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

function entry(over: Partial<WordbookEntryInput> = {}): WordbookEntryInput {
  return {
    languageCode: 'fr',
    lemma: 'chat',
    surfaces: ['chat'],
    contexts: [],
    occurrenceCount: 1,
    documentCount: 1,
    status: 'known',
    isFavorite: false,
    starAngle: 0,
    starColor: '#eab308',
    seenCount: 1,
    firstSeenAt: OLDER_SNAPSHOT,
    lastSeenAt: OLDER_SNAPSHOT,
    favoriteUpdatedAt: null,
    knownPresses: 0,
    unsurePresses: 0,
    unknownPresses: 0,
    note: 'local note',
    noteUpdatedAt: OLDER_SNAPSHOT,
    serverUpdatedAt: OLDER_SNAPSHOT,
    ...over,
  }
}

function remoteDoc(over: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    user_id: USER_ID,
    title: 'Le chat',
    language_code: 'fr',
    raw_text: 'Le chat dort.',
    created_at: OLDER_SNAPSHOT,
    updated_at: OLDER_SNAPSHOT,
    deleted_at: null,
    folder_id: null,
    folder_updated_at: null,
    server_updated_at: SNAPSHOT,
    last_opened_at: OLDER_SNAPSHOT,
    content_updated_at: OLDER_SNAPSHOT,
    occurrences_updated_at: OLDER_SNAPSHOT,
    ...over,
  }
}

function localDoc(): Document {
  return {
    id: 'doc-1',
    title: 'Le chat',
    languageCode: 'fr',
    rawText: 'Le chat dort.',
    createdAt: OLDER_SNAPSHOT,
    updatedAt: OLDER_SNAPSHOT,
  }
}

function localOccurrence(): WordOccurrence {
  return {
    documentId: 'doc-1',
    languageCode: 'fr',
    lemma: 'chat',
    surfaces: ['chat'],
    count: 2,
    charStart: 0,
    charEnd: 4,
    sentence: 'Le chat dort.',
    documentTitle: 'Le chat',
    recordedAt: Date.parse(OLDER_SNAPSHOT),
  }
}

/** Records the projection RPC arguments so language scoping can be asserted. */
function recordingClient(server: Server) {
  const calls: Array<{
    language: string
    afterLemma: string | null
    snapshot: string | null
    updatedSince: string | null
  }> = []
  const base = server.client as unknown as {
    rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>
  }
  const client = {
    ...(server.client as unknown as Record<string, unknown>),
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (
        name === 'get_wordbook_projection_page' ||
        name === 'get_wordbook_projection_page_bounded'
      ) {
        calls.push({
          language: String(args.p_language_code),
          afterLemma: (args.p_after_lemma as string | null) ?? null,
          snapshot: (args.p_snapshot as string | null) ?? null,
          updatedSince: (args.p_updated_since as string | null) ?? null,
        })
      }
      return base.rpc(name, args)
    },
  }
  return { client: client as never, calls }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

beforeEach(async () => {
  await deleteLocalDatabase()
  ;(globalThis as { localStorage?: Storage }).localStorage?.clear()
})

describe('R2 upgrade and the full projection', () => {
  it('pulls each enrolled language and never clears the R2 push watermarks', async () => {
    const server = memoryServer(1000, SNAPSHOT)
    server.add('wordbook_entries', projectionRow({ language_code: 'fr', lemma: 'chat' }))
    server.add('wordbook_entries', projectionRow({ language_code: 'de', lemma: 'Haus' }))
    const r2State: StoredSyncState = {
      version: 2,
      pull: { snapshot: R2_PULL },
      push: {
        documents: OLDER_SNAPSHOT,
        wordStates: OLDER_SNAPSHOT,
      },
      localEpoch: 'r2-epoch',
    }
    writeStoredSyncState(USER_ID, r2State)

    const report = await syncOnce({
      userId: USER_ID,
      languages: ['fr', 'de'],
      db: server.client,
      since: r2State.pull,
      push: r2State.push,
    })

    expect(report.projectionLanguages.sort()).toEqual(['de', 'fr'])
    expect(report.projectionComplete).toEqual({ fr: true, de: true })
    expect(report.projectionPaused).toEqual([])
    expect((await readWordbookEntries('fr')).map((row) => row.lemma)).toEqual(['chat'])
    expect((await readWordbookEntries('de')).map((row) => row.lemma)).toEqual(['Haus'])

    // The upgrade adds projection state; it must not reset the version 2 state
    // or the R2 push watermarks.
    expect(readStoredSyncState(USER_ID)).toEqual(r2State)
    expect(report.pushWatermarks.documents).toBeDefined()
    expect(report.pushWatermarks.wordStates).toBeDefined()

    const state = await readProjectionState(USER_ID)
    expect(projectionStateFor(state, 'fr')).toMatchObject({ complete: true, cursor: null })
    expect(projectionStateFor(state, 'de')).toMatchObject({ complete: true, cursor: null })
    // Full pages were bounded by the cycle snapshot; no incremental watermark
    // was mixed into the full request.
    expect(state.fr.snapshot).toBe(SNAPSHOT)
  })

  it('initializes the word-state watermark to the projection snapshot, not to a reset map', async () => {
    // A future server snapshot makes the difference observable: the cycle clock
    // is earlier, so only the projection snapshot can explain the stored value.
    const futureSnapshot = new Date(Date.now() + 24 * 60 * 60_000).toISOString()
    const server = memoryServer(1000, futureSnapshot)
    server.add(
      'wordbook_entries',
      projectionRow({ server_updated_at: futureSnapshot }),
    )
    const r2State: StoredSyncState = {
      version: 2,
      pull: { snapshot: R2_PULL },
      push: { documents: OLDER_SNAPSHOT, wordStates: OLDER_SNAPSHOT },
      localEpoch: 'r2-epoch',
    }
    writeStoredSyncState(USER_ID, r2State)

    const report = await syncOnce({
      userId: USER_ID,
      languages: ['fr'],
      db: server.client,
      since: r2State.pull,
      // A future watermark would trip the clock guard, so use the R2 values.
      push: r2State.push,
    })

    expect(report.pushWatermarks.wordStates).toBe(futureSnapshot)
    expect(report.pushWatermarks.documents).toBeDefined()
    expect(Date.parse(report.pushWatermarks.documents ?? '')).toBeGreaterThan(
      Date.parse(OLDER_SNAPSHOT),
    )
    expect(readStoredSyncState(USER_ID)).toEqual(r2State)
  })

  it('keeps the existing local wordbook visible while the projection downloads', async () => {
    const server = memoryServer(1000, SNAPSHOT)
    server.add('wordbook_entries', projectionRow({ lemma: 'chat', note: 'server' }))
    server.add('wordbook_entries', projectionRow({ lemma: 'chien' }))
    await putWordbookEntries([entry()])
    await idbPut(STORES.wordStates, {
      languageCode: 'fr',
      lemma: 'chat',
      status: 'known',
      seenCount: 1,
      firstSeenAt: OLDER_SNAPSHOT,
      lastSeenAt: OLDER_SNAPSHOT,
    })
    // The dirty re-seed is source-backed only; an occurrence proves this word
    // belongs in the local wordbook while the projection is downloading.
    await idbPut(STORES.wordOccurrences, localOccurrence())

    const entered = deferred()
    const release = deferred()
    const base = server.client as unknown as {
      rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>
    }
    let gated = false
    const client = {
      ...(server.client as unknown as Record<string, unknown>),
      rpc: async (name: string, args: Record<string, unknown>) => {
        const result = await base.rpc(name, args)
        if (
          (name === 'get_wordbook_projection_page' ||
            name === 'get_wordbook_projection_page_bounded') &&
          !gated
        ) {
          gated = true
          entered.resolve()
          await release.promise
        }
        return result
      },
    } as never

    const run = syncOnce({ userId: USER_ID, languages: ['fr'], db: client })
    await entered.promise

    // The cycle has not written anything yet: the local wordbook is intact.
    expect((await readWordbookEntries('fr')).map((row) => row.lemma).sort()).toEqual(['chat'])
    expect(await idbGetAll(STORES.wordStates)).toHaveLength(1)

    release.resolve()
    const report = await run

    expect(report.projectionComplete.fr).toBe(true)
    expect((await readWordbookEntries('fr')).map((row) => row.lemma).sort()).toEqual([
      'chat',
      'chien',
    ])
  })
})

describe('initial projection path', () => {
  it('reads no word_states or occurrences; the projection is the whole wordbook', async () => {
    const server = memoryServer(1000, SNAPSHOT)
    server.add('wordbook_entries', projectionRow())
    server.add('word_states', {
      id: 'ws-1',
      user_id: USER_ID,
      language_code: 'fr',
      lemma: 'chat',
      status: 'known',
      seen_count: 2,
      first_seen_at: OLDER_SNAPSHOT,
      last_seen_at: OLDER_SNAPSHOT,
      is_favorite: false,
      favorite_updated_at: OLDER_SNAPSHOT,
      star_angle: 0,
      star_color: '#eab308',
      server_updated_at: SNAPSHOT,
    })
    server.add('word_occurrences', {
      id: 1,
      user_id: USER_ID,
      document_id: 'doc-1',
      language_code: 'fr',
      lemma: 'chat',
      surface: 'chat',
      char_start: 0,
      char_end: 4,
      sentence: 'Le chat dort.',
      occurrences_count: 2,
    })

    const reads: Record<string, number> = {}
    server.afterPage((table) => {
      reads[table] = (reads[table] ?? 0) + 1
    })

    const report = await syncOnce({ userId: USER_ID, languages: ['fr'], db: server.client })

    expect(reads.word_states ?? 0).toBe(0)
    expect(reads.word_occurrences ?? 0).toBe(0)
    expect(report.pulled).toBe(1)
    // The state came from the projection, not from a full word_states pull.
    expect(await idbGetAll(STORES.wordStates)).toMatchObject([
      { languageCode: 'fr', lemma: 'chat', status: 'known' },
    ])
  })
})

describe('projection completeness', () => {
  it('pulls only the new language while a complete language runs incrementally', async () => {
    const server = memoryServer(1000, SNAPSHOT)
    server.add('wordbook_entries', projectionRow({ language_code: 'fr', lemma: 'chat' }))
    server.add('wordbook_entries', projectionRow({ language_code: 'de', lemma: 'Haus' }))
    await putWordbookEntries([entry()])
    await writeProjectionState(USER_ID, {
      fr: {
        complete: true,
        snapshot: SNAPSHOT,
        cursor: null,
        hydratedAt: SNAPSHOT,
      },
    })

    const { client, calls } = recordingClient(server)
    const report = await syncOnce({
      userId: USER_ID,
      languages: ['fr', 'de'],
      db: client,
    })

    const deCalls = calls.filter((call) => call.language === 'de')
    const frCalls = calls.filter((call) => call.language === 'fr')
    expect(deCalls.length).toBeGreaterThan(0)
    expect(deCalls.every((call) => call.snapshot === SNAPSHOT)).toBe(true)
    expect(frCalls.every((call) => call.snapshot === null)).toBe(true)
    expect(frCalls.every((call) => call.updatedSince === incrementalSince(SNAPSHOT))).toBe(true)
    expect(report.projectionComplete).toEqual({ fr: true, de: true })
    expect((await readWordbookEntries('fr')).map((row) => row.lemma)).toEqual(['chat'])
    expect((await readWordbookEntries('de')).map((row) => row.lemma)).toEqual(['Haus'])
  })

  it('restarts a paused incremental at its watermark so rows behind the cursor are not skipped', async () => {
    const server = memoryServer(1000, SNAPSHOT)
    // A row that changed *behind* the stored incremental cursor while a pass
    // would have been paused. A cursor-based resume would never return it.
    server.add(
      'wordbook_entries',
      projectionRow({
        lemma: 'aaa-changed',
        note: 'changed behind the cursor',
        server_updated_at: CHANGED_AT,
      }),
    )
    server.add(
      'wordbook_entries',
      projectionRow({
        lemma: 'zzz-old',
        note: 'already applied',
        server_updated_at: CHANGED_AT,
      }),
    )
    await writeProjectionState(USER_ID, {
      fr: {
        complete: true,
        snapshot: OLDER_SNAPSHOT,
        // A state left by a build that paused incremental passes. Its cursor is
        // past the row that changed behind it.
        cursor: { languageCode: 'fr', lemma: 'zzz' },
        hydratedAt: OLDER_SNAPSHOT,
      },
    })

    const { client, calls } = recordingClient(server)
    const report = await syncOnce({
      userId: USER_ID,
      languages: ['fr'],
      db: client,
    })

    // The incremental starts at the watermark and ignores the stored cursor.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.afterLemma).toBeNull()
    expect(calls.every((call) => call.updatedSince === incrementalSince(OLDER_SNAPSHOT))).toBe(
      true,
    )
    const rows = await readWordbookEntries('fr')
    expect(rows.find((row) => row.lemma === 'aaa-changed')?.note).toBe(
      'changed behind the cursor',
    )
    expect(report.projectionComplete.fr).toBe(true)
    // Completion advances to this cycle's snapshot, so the next pull starts
    // after every row already applied.
    expect(projectionStateFor(await readProjectionState(USER_ID), 'fr').snapshot).toBe(SNAPSHOT)
  })

  it('terminates a multi-page incremental pass and applies every row once', async () => {
    const server = memoryServer(2000, SNAPSHOT)
    const total = 1005
    for (let index = 0; index < total; index++) {
      server.add(
        'wordbook_entries',
        projectionRow({
          lemma: `mot-${String(index).padStart(4, '0')}`,
          note: 'changed',
          server_updated_at: CHANGED_AT,
        }),
      )
    }
    await writeProjectionState(USER_ID, {
      fr: {
        complete: true,
        snapshot: OLDER_SNAPSHOT,
        cursor: null,
        hydratedAt: OLDER_SNAPSHOT,
      },
    })

    const { client, calls } = recordingClient(server)
    const report = await syncOnce({ userId: USER_ID, languages: ['fr'], db: client })

    // First page from the watermark, then a keyset page after the last lemma of
    // the first page. The 5-row short page ends the pass.
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      afterLemma: null,
      updatedSince: incrementalSince(OLDER_SNAPSHOT),
    })
    expect(calls[1]).toMatchObject({
      afterLemma: 'mot-0999',
      updatedSince: incrementalSince(OLDER_SNAPSHOT),
    })

    const rows = await readWordbookEntries('fr')
    expect(rows).toHaveLength(total)
    expect(new Set(rows.map((row) => row.lemma)).size).toBe(total)
    expect(report.projectionComplete.fr).toBe(true)
    expect(projectionStateFor(await readProjectionState(USER_ID), 'fr').snapshot).toBe(SNAPSHOT)
  }, 20_000)

  it('resumes a paused manual reset instead of clearing and restarting it', async () => {
    const server = memoryServer(2000, SNAPSHOT)
    for (let index = 0; index < 1050; index++) {
      server.add(
        'wordbook_entries',
        projectionRow({
          lemma: `mot-${String(index).padStart(4, '0')}`,
          note: 'x'.repeat(50),
        }),
      )
    }

    // A pre-existing entry outside the server projection. The first reset
    // clears it (full pages cannot express its removal); a reset that restarts
    // on the second cycle would clear the sentinel seeded afterwards too.
    await putWordbookEntries([entry({ lemma: 'aaa-sentinel' })])

    const first = await syncOnce({
      userId: USER_ID,
      languages: ['fr'],
      db: server.client,
      resetProjection: true,
      projectionByteBudget: 1024,
    })
    expect(first.projectionPaused).toEqual(['fr'])
    expect((await readWordbookEntries('fr')).some((row) => row.lemma === 'aaa-sentinel')).toBe(
      false,
    )

    await putWordbookEntries([entry({ lemma: 'zzz-sentinel' })])

    // The app keeps the resync request owed until the pull succeeds; even if
    // the reset flag is passed again, the pass in progress must resume.
    const second = await syncOnce({
      userId: USER_ID,
      languages: ['fr'],
      db: server.client,
      resetProjection: true,
      projectionByteBudget: 1024,
    })

    expect(second.projectionPaused).toEqual([])
    expect(second.projectionComplete.fr).toBe(true)
    const rows = await readWordbookEntries('fr')
    expect(rows.some((row) => row.lemma === 'zzz-sentinel')).toBe(true)
    expect(rows.length).toBe(1051)
  })

  it('rereads the five-minute overlap so a row committed behind the watermark is not lost', async () => {
    const server = memoryServer(1000, SNAPSHOT)
    // Stamped before the stored watermark but committed late enough to be read
    // only by an overlap query. Without the overlap this row is invisible
    // forever because the next watermark is the snapshot itself.
    server.add(
      'wordbook_entries',
      projectionRow({
        lemma: 'late-row',
        note: 'committed behind the watermark',
        server_updated_at: new Date(Date.parse(OLDER_SNAPSHOT) - 60_000).toISOString(),
      }),
    )
    server.add(
      'wordbook_entries',
      projectionRow({
        lemma: 'new-row',
        note: 'after the watermark',
        server_updated_at: CHANGED_AT,
      }),
    )
    await writeProjectionState(USER_ID, {
      fr: {
        complete: true,
        snapshot: OLDER_SNAPSHOT,
        cursor: null,
        hydratedAt: OLDER_SNAPSHOT,
      },
    })

    const { client, calls } = recordingClient(server)
    const report = await syncOnce({ userId: USER_ID, languages: ['fr'], db: client })

    expect(calls.every((call) => call.updatedSince === incrementalSince(OLDER_SNAPSHOT))).toBe(
      true,
    )
    const rows = await readWordbookEntries('fr')
    expect(rows.find((row) => row.lemma === 'late-row')?.note).toBe(
      'committed behind the watermark',
    )
    expect(rows.find((row) => row.lemma === 'new-row')?.note).toBe('after the watermark')
    expect(report.projectionComplete.fr).toBe(true)
    // Completion still stores the snapshot, not the overlap start.
    expect(projectionStateFor(await readProjectionState(USER_ID), 'fr').snapshot).toBe(SNAPSHOT)
  })

  it('applies the byte budget to incremental passes and resumes without skipping', async () => {
    const server = memoryServer(2000, SNAPSHOT)
    const total = 1005
    for (let index = 0; index < total; index++) {
      server.add(
        'wordbook_entries',
        projectionRow({
          lemma: `mot-${String(index).padStart(4, '0')}`,
          note: 'x'.repeat(50),
          server_updated_at: CHANGED_AT,
        }),
      )
    }
    await writeProjectionState(USER_ID, {
      fr: {
        complete: true,
        snapshot: OLDER_SNAPSHOT,
        cursor: null,
        hydratedAt: OLDER_SNAPSHOT,
      },
    })

    const first = await syncOnce({
      userId: USER_ID,
      languages: ['fr'],
      db: server.client,
      projectionByteBudget: 1024,
    })

    expect(first.projectionPaused).toContain('fr')
    expect(first.projectionPausedReason).toBe('bytes')
    // The language is still complete at its previous watermark; this cycle's
    // change set did not finish.
    expect(first.projectionComplete.fr).toBe(true)
    const paused = projectionStateFor(await readProjectionState(USER_ID), 'fr')
    expect(paused).toMatchObject({
      complete: true,
      snapshot: OLDER_SNAPSHOT,
      cursor: null,
      pause: {
        reason: 'bytes',
        nextAttemptAt: null,
        quotaBucket: null,
        retryAfterSeconds: null,
      },
    })
    const applied = await readWordbookEntries('fr')
    expect(applied.length).toBeGreaterThan(0)
    expect(applied.length).toBeLessThan(total)

    const second = await syncOnce({ userId: USER_ID, languages: ['fr'], db: server.client })

    expect(second.projectionPaused).toEqual([])
    const rows = await readWordbookEntries('fr')
    expect(rows).toHaveLength(total)
    expect(new Set(rows.map((row) => row.lemma)).size).toBe(total)
    const finished = projectionStateFor(await readProjectionState(USER_ID), 'fr')
    expect(finished.snapshot).toBe(SNAPSHOT)
    expect(finished.pause).toBeUndefined()
  }, 20_000)

  it('starts a reusable read session and keeps it across a paused pass', async () => {
    const server = memoryServer(2000, SNAPSHOT)
    for (let index = 0; index < 1050; index++) {
      server.add(
        'wordbook_entries',
        projectionRow({ lemma: `mot-${String(index).padStart(4, '0')}`, note: 'x'.repeat(50) }),
      )
    }

    const first = await syncOnce({
      userId: USER_ID,
      languages: ['fr'],
      db: server.client,
      projectionByteBudget: 1024,
    })

    expect(first.projectionPaused).toEqual(['fr'])
    const paused = projectionStateFor(await readProjectionState(USER_ID), 'fr')
    expect(paused.sessionId).toBe('00000000-0000-4000-8000-000000000001')
    expect(server.rpcCalls('begin_projection_read')).toBe(1)

    const second = await syncOnce({
      userId: USER_ID,
      languages: ['fr'],
      db: server.client,
      projectionByteBudget: 1024,
    })
    expect(second.projectionPaused).toEqual([])
    expect(server.rpcCalls('begin_projection_read')).toBe(1)
    const completed = projectionStateFor(await readProjectionState(USER_ID), 'fr')
    expect(completed.complete).toBe(true)
    expect(completed.sessionId).toBeUndefined()
  }, 20_000)

  it('leaves a paused projection untouched when automatic resume is not allowed', async () => {
    const server = memoryServer(2000, SNAPSHOT)
    for (let index = 0; index < 1050; index++) {
      server.add(
        'wordbook_entries',
        projectionRow({ lemma: `mot-${String(index).padStart(4, '0')}`, note: 'x'.repeat(50) }),
      )
    }

    const first = await syncOnce({
      userId: USER_ID,
      languages: ['fr'],
      db: server.client,
      projectionByteBudget: 1024,
    })
    expect(first.projectionPaused).toEqual(['fr'])
    const paused = projectionStateFor(await readProjectionState(USER_ID), 'fr')
    expect(paused.pause?.reason).toBe('bytes')

    const blocked = recordingClient(server)
    const second = await syncOnce({
      userId: USER_ID,
      languages: ['fr'],
      db: blocked.client,
      resumePausedProjection: false,
    })

    expect(blocked.calls).toHaveLength(0)
    expect(second.projectionPaused).toEqual([])
    const stillPaused = projectionStateFor(await readProjectionState(USER_ID), 'fr')
    expect(stillPaused.cursor).toEqual(paused.cursor)
    expect(stillPaused.pause?.reason).toBe('bytes')
  }, 20_000)

  it('restarts an interrupted first projection on the same snapshot and spends one pass', async () => {
    const server = memoryServer(2000, SNAPSHOT)
    const total = 1050
    for (let index = 0; index < total; index++) {
      server.add(
        'wordbook_entries',
        projectionRow({ lemma: `mot-${String(index).padStart(4, '0')}` }),
      )
    }

    const calls: Array<{ snapshot: string | null; afterLemma: string | null }> = []
    const base = server.client as unknown as {
      rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>
    }
    let failed = false
    const client = {
      ...(server.client as unknown as Record<string, unknown>),
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === 'get_wordbook_projection_page_bounded') {
          calls.push({
            snapshot: (args.p_snapshot as string | null) ?? null,
            afterLemma: (args.p_after_lemma as string | null) ?? null,
          })
          // Fail page 2 of the first attempt. The server has already charged
          // the snapshot and stored page 1's cursor.
          if (!failed && args.p_after_lemma === 'mot-0999') {
            failed = true
            return { data: null, error: { message: 'page 2 failed' } }
          }
        }
        return base.rpc(name, args)
      },
    } as never

    await expect(syncOnce({ userId: USER_ID, languages: ['fr'], db: client })).rejects.toThrow(
      'page 2 failed',
    )

    // Nothing was applied and no cursor was stored, but the snapshot was
    // persisted before the first page.
    expect(await readWordbookEntries('fr')).toHaveLength(0)
    const interrupted = projectionStateFor(await readProjectionState(USER_ID), 'fr')
    expect(interrupted).toMatchObject({
      complete: false,
      snapshot: SNAPSHOT,
      cursor: null,
    })

    // The next cycle would normally take this newer snapshot. The interrupted
    // pass must reuse the charged snapshot instead.
    server.setSnapshot(new Date(Date.parse(SNAPSHOT) + 60 * 60_000).toISOString())
    const pagesBefore = calls.length
    const report = await syncOnce({ userId: USER_ID, languages: ['fr'], db: client })

    expect(report.projectionComplete.fr).toBe(true)
    expect(report.projectionPaused).toEqual([])
    const retryCalls = calls.slice(pagesBefore)
    expect(retryCalls.length).toBeGreaterThan(0)
    expect(retryCalls.every((call) => call.snapshot === SNAPSHOT)).toBe(true)
    expect(retryCalls[0]?.afterLemma).toBeNull()
    // Every page of both attempts used one snapshot: one daily pass.
    expect(new Set(calls.map((call) => call.snapshot))).toEqual(new Set([SNAPSHOT]))
    const rows = await readWordbookEntries('fr')
    expect(rows).toHaveLength(total)
    expect(new Set(rows.map((row) => row.lemma)).size).toBe(total)
  })

  it('does not re-seed a dirty word state that has no local occurrence', async () => {
    const server = memoryServer(1000, SNAPSHOT)
    server.add('wordbook_entries', projectionRow({ lemma: 'chat' }))

    // A learned state can outlive its occurrences. Seeding it would create a
    // wordbook row the server has already soft-deleted.
    await idbPut(STORES.wordStates, {
      languageCode: 'fr',
      lemma: 'phantom',
      status: 'known',
      seenCount: 1,
      firstSeenAt: OLDER_SNAPSHOT,
      lastSeenAt: OLDER_SNAPSHOT,
      note: 'no occurrence left',
      noteUpdatedAt: OLDER_SNAPSHOT,
    })

    const report = await syncOnce({
      userId: USER_ID,
      languages: ['fr'],
      db: server.client,
      resetProjection: true,
    })

    expect(report.projectionComplete.fr).toBe(true)
    expect((await readWordbookEntries('fr')).map((row) => row.lemma)).toEqual(['chat'])
  })

  it('does not clear a fresh language that received no page when another pass is rejected', async () => {
    const server = memoryServer(1000, SNAPSHOT)
    server.add('wordbook_entries', projectionRow({ language_code: 'fr', lemma: 'chat' }))
    server.add('wordbook_entries', projectionRow({ language_code: 'de', lemma: 'Haus' }))
    await putWordbookEntries([entry({ languageCode: 'de', lemma: 'de-sentinel' })])

    const base = server.client as unknown as {
      rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>
    }
    let rejected = false
    const client = {
      ...(server.client as unknown as Record<string, unknown>),
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (
          name === 'get_wordbook_projection_page_bounded' &&
          args.p_language_code === 'de' &&
          !rejected
        ) {
          rejected = true
          return {
            data: null,
            error: {
              code: 'PT409',
              details: 'reason=start',
              message: 'projection cursor does not match this pass',
            },
          }
        }
        return base.rpc(name, args)
      },
    } as never

    const report = await syncOnce({ userId: USER_ID, languages: ['fr', 'de'], db: client })

    expect(report.projectionPaused).toContain('de')
    // `de` read nothing, so its local wordbook must survive even though a full
    // pass would normally clear it before applying rows.
    expect((await readWordbookEntries('de')).map((row) => row.lemma)).toContain('de-sentinel')
    // The rejected pass keeps its charged snapshot for a same-snapshot retry.
    const deState = projectionStateFor(await readProjectionState(USER_ID), 'de')
    expect(deState.snapshot).toBe(SNAPSHOT)
    expect(deState.cursor).toBeNull()
  })

  it('resumes a paused full projection from its stored cursor instead of throwing', async () => {
    const server = memoryServer(2000, SNAPSHOT)
    for (let index = 0; index < 1050; index++) {
      server.add(
        'wordbook_entries',
        projectionRow({
          lemma: `mot-${String(index).padStart(4, '0')}`,
          // Make each row worth more than a byte, so the tiny test budget
          // pauses after the first full page instead of on the last page.
          note: 'x'.repeat(50),
        }),
      )
    }

    const first = await syncOnce({
      userId: USER_ID,
      languages: ['fr'],
      db: server.client,
      projectionByteBudget: 1024,
    })

    expect(first.projectionPaused).toEqual(['fr'])
    expect(first.projectionComplete.fr).toBe(false)
    expect(await readWordbookEntries('fr')).toHaveLength(1000)
    const pausedState = projectionStateFor(await readProjectionState(USER_ID), 'fr')
    expect(pausedState.complete).toBe(false)
    expect(pausedState.cursor?.lemma).toBe('mot-0999')

    const second = await syncOnce({
      userId: USER_ID,
      languages: ['fr'],
      db: server.client,
      projectionByteBudget: 1024,
    })

    expect(second.projectionPaused).toEqual([])
    expect(second.projectionComplete.fr).toBe(true)
    const complete = projectionStateFor(await readProjectionState(USER_ID), 'fr')
    expect(complete.complete).toBe(true)
    expect(complete.cursor).toBeNull()
    expect(complete.snapshot).toBe(SNAPSHOT)
    expect(await readWordbookEntries('fr')).toHaveLength(1050)
  })
})

describe('fresh full passes replace the language', () => {
  it('removes entries absent from the full page and re-seeds a dirty local edit', async () => {
    const server = memoryServer(1000, SNAPSHOT)
    server.add(
      'wordbook_entries',
      projectionRow({
        lemma: 'chat',
        note: 'server note',
        note_updated_at: SNAPSHOT,
        server_updated_at: SNAPSHOT,
      }),
    )
    server.add('wordbook_entries', projectionRow({ lemma: 'chien' }))

    // An entry from an earlier projection that the server no longer has. A
    // fresh full pass (no state, as after an upgrade or corrupted state) must
    // not leave it as a phantom.
    await putWordbookEntries([
      entry({ lemma: 'phantom' }),
      entry({ lemma: 'chat', note: 'local note' }),
    ])
    // An unpushed edit: the merge skips this key, so the seeded row must keep
    // the local state visible for this cycle.
    await idbPut(STORES.wordStates, {
      languageCode: 'fr',
      lemma: 'chat',
      status: 'known',
      seenCount: 2,
      firstSeenAt: OLDER_SNAPSHOT,
      lastSeenAt: SNAPSHOT,
      favorite: false,
      starAngle: 0,
      starColor: '#eab308',
      knownPresses: 0,
      unsurePresses: 0,
      unknownPresses: 0,
      note: 'local note',
      noteUpdatedAt: SNAPSHOT,
    })
    // The local edit is real because a local occurrence backs it.
    await idbPut(STORES.wordOccurrences, localOccurrence())

    const report = await syncOnce({ userId: USER_ID, languages: ['fr'], db: server.client })

    const rows = await readWordbookEntries('fr')
    expect(rows.map((row) => row.lemma).sort()).toEqual(['chat', 'chien'])
    expect(rows.find((row) => row.lemma === 'chat')?.note).toBe('local note')
    expect(report.projectionComplete.fr).toBe(true)
  })
})

describe('projection deletions and dirty local edits', () => {
  it('removes a soft-deleted projection entry instead of leaving a phantom', async () => {
    const server = memoryServer(1000, SNAPSHOT)
    server.add(
      'wordbook_entries',
      projectionRow({
        lemma: 'chat',
        deleted_at: SNAPSHOT,
        server_updated_at: SNAPSHOT,
      }),
    )
    await putWordbookEntries([entry({ lemma: 'chat' }), entry({ lemma: 'chien' })])
    // The word state is learning history. The projection row is gone because
    // the word no longer occurs, but the state (and its note) must stay.
    await idbPut(STORES.wordStates, {
      languageCode: 'fr',
      lemma: 'chat',
      status: 'known',
      seenCount: 3,
      firstSeenAt: OLDER_SNAPSHOT,
      lastSeenAt: OLDER_SNAPSHOT,
      note: 'kept note',
      noteUpdatedAt: OLDER_SNAPSHOT,
    })
    await writeProjectionState(USER_ID, {
      fr: {
        complete: true,
        snapshot: OLDER_SNAPSHOT,
        cursor: null,
        hydratedAt: OLDER_SNAPSHOT,
      },
    })

    const report = await syncOnce({ userId: USER_ID, languages: ['fr'], db: server.client })

    expect(report.projectionComplete.fr).toBe(true)
    expect((await readWordbookEntries('fr')).map((row) => row.lemma)).toEqual(['chien'])
    const states = await idbGetAll<{ lemma: string; note?: string }>(STORES.wordStates)
    expect(states).toMatchObject([{ lemma: 'chat', note: 'kept note' }])
  })

  it('does not overwrite a key whose local word state is dirty', async () => {
    const server = memoryServer(1000, SNAPSHOT)
    server.add(
      'wordbook_entries',
      projectionRow({
        lemma: 'chat',
        note: 'server note',
        note_updated_at: SNAPSHOT,
        server_updated_at: SNAPSHOT,
      }),
    )
    await putWordbookEntries([entry({ note: 'local note' })])
    // A user write: this is what puts `fr\0chat` in the dirty journal.
    await idbPut(STORES.wordStates, {
      languageCode: 'fr',
      lemma: 'chat',
      status: 'known',
      seenCount: 1,
      firstSeenAt: OLDER_SNAPSHOT,
      lastSeenAt: SNAPSHOT,
      favorite: false,
      starAngle: 0,
      starColor: '#eab308',
      knownPresses: 0,
      unsurePresses: 0,
      unknownPresses: 0,
      note: 'local note',
      noteUpdatedAt: SNAPSHOT,
    })
    await writeProjectionState(USER_ID, {
      fr: {
        complete: true,
        snapshot: OLDER_SNAPSHOT,
        cursor: null,
        hydratedAt: OLDER_SNAPSHOT,
      },
    })

    await syncOnce({ userId: USER_ID, languages: ['fr'], db: server.client })

    const localRow = (await readWordbookEntries('fr')).find((row) => row.lemma === 'chat')
    expect(localRow?.note).toBe('local note')
    const state = (await idbGetAll<{ lemma: string; note?: string }>(STORES.wordStates)).find(
      (row) => row.lemma === 'chat',
    )
    expect(state?.note).toBe('local note')
  })
})

describe('occurrence and content isolation', () => {
  it('does not read occurrences for a document that was only opened elsewhere', async () => {
    const server = memoryServer(1000, SNAPSHOT)
    server.add(
      'documents',
      remoteDoc({
        // Opened now; content and occurrences are unchanged since the last pull.
        last_opened_at: SNAPSHOT,
        server_updated_at: SNAPSHOT,
        occurrences_updated_at: CONTENT_SNAPSHOT,
        content_updated_at: CONTENT_SNAPSHOT,
      }),
    )
    await idbPut(STORES.documents, localDoc())
    await idbPut(STORES.wordOccurrences, localOccurrence())

    let occurrenceReads = 0
    server.afterPage((table) => {
      if (table === 'word_occurrences') occurrenceReads += 1
    })

    const report = await syncOnce({
      userId: USER_ID,
      languages: ['fr'],
      db: server.client,
      since: { snapshot: OLDER_SNAPSHOT },
      push: {
        documents: SNAPSHOT,
        folders: SNAPSHOT,
        wordStates: SNAPSHOT,
        tombstones: SNAPSHOT,
        occurrences: SNAPSHOT,
      },
    })

    expect(occurrenceReads).toBe(0)
    expect(report.localWrites.occurrences).toBe(0)
    expect(await idbGetAll(STORES.wordOccurrences)).toHaveLength(1)
    // No lazy content fetch is planned by a metadata-only change either.
    expect(await idbGetAll(STORES.documentContent)).toHaveLength(0)
  })
})

describe('byte-bounded projection pages', () => {
  it('continues after a short page that reports hasMore instead of treating it as the end', async () => {
    const server = memoryServer(1000, SNAPSHOT)
    server.add('wordbook_entries', projectionRow({ lemma: 'alpha' }))
    server.add('wordbook_entries', projectionRow({ lemma: 'beta' }))
    server.add('wordbook_entries', projectionRow({ lemma: 'gamma' }))

    const base = server.client as unknown as {
      rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>
    }
    let shortPageSent = false
    const client = {
      ...(server.client as unknown as Record<string, unknown>),
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (
          name === 'get_wordbook_projection_page_bounded' &&
          args.p_after_lemma === null &&
          !shortPageSent
        ) {
          shortPageSent = true
          // Simulate the server's ~1 MB cap: one row, but the language goes on.
          return {
            data: {
              rows: [projectionRow({ lemma: 'alpha' })],
              hasMore: true,
              nextCursor: 'alpha',
            },
            error: null,
          }
        }
        return base.rpc(name, args)
      },
    } as never

    const report = await syncOnce({ userId: USER_ID, languages: ['fr'], db: client })

    expect(report.projectionComplete.fr).toBe(true)
    expect((await readWordbookEntries('fr')).map((row) => row.lemma).sort()).toEqual([
      'alpha',
      'beta',
      'gamma',
    ])
  })
})

describe('projection page reads over the same RPC', () => {
  it('reads a full page without soft deletions and an incremental page with them', async () => {
    const server = memoryServer(1000, SNAPSHOT)
    server.add('wordbook_entries', projectionRow({ lemma: 'chat' }))
    server.add(
      'wordbook_entries',
      projectionRow({ lemma: 'chien', deleted_at: SNAPSHOT }),
    )

    const full = await pullProjectionPage(server.client, USER_ID, 'fr', SNAPSHOT, null, 100)
    expect(full.map((row) => row.lemma)).toEqual(['chat'])

    const incremental = await pullProjectionPage(
      server.client,
      USER_ID,
      'fr',
      null,
      null,
      100,
      OLDER_SNAPSHOT,
    )
    expect(incremental.map((row) => row.lemma)).toEqual(['chat', 'chien'])
  })
})

/**
 * The local read model must be removable by key without touching other
 * languages; used by the reset path and by these fixtures.
 */
describe('projection fixture helpers', () => {
  it('deleteWordbookEntry removes exactly one key', async () => {
    await putWordbookEntries([entry(), entry({ lemma: 'chien' })])
    await deleteWordbookEntry('fr', 'chien')
    expect((await readWordbookEntries('fr')).map((row) => row.lemma)).toEqual(['chat'])
  })
})
