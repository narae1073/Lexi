import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { User } from '@supabase/supabase-js'

/**
 * 동기화 문은 계정 소유자가 연다.
 *
 * 이 기기에 남은 기록이 누구의 것인지 모르는 채로 동기화하면 남의 기록이 새 계정으로
 * 올라간다. 아래 시험은 '무엇을 할 수 있는가' 를 소유자와 계정만으로 판정하는지,
 * 그리고 그 판정을 스토어가 실제로 지키는지 확인한다.
 *
 * 병합·전송 엔진은 여기서 시험하지 않는다 — 문 앞에서 멈추는지만 본다.
 */
vi.mock('../../lib/sync/sync', () => ({
  SyncUnavailable: class SyncUnavailable extends Error {},
  syncOnce: vi.fn(),
}))

import { LOCAL_OWNER_KEY, readLocalOwner, writeLocalOwner, type OwnerStorage } from '../../lib/storage/accountOwner'
import { useLanguagesStore } from './languages'
import { useAuthStore } from './auth'
import {
  canSyncForUser,
  initializeLocalOwner,
  isAccountGateReady,
  ownerSyncState,
  useSyncStore,
  waitForSyncIdle,
} from './sync'
import { syncOnce, type SyncReport } from '../../lib/sync/sync'
import { useDocumentsStore } from './documents'
import { useFoldersStore } from './folders'
import { useOccurrencesStore } from './occurrences'
import { useWordStatesStore } from './wordStates'

class MemoryStorage implements OwnerStorage {
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
}

function explodingRead(): OwnerStorage {
  return {
    getItem() {
      throw new Error('저장소를 읽을 수 없음')
    },
    setItem() {},
    removeItem() {},
  }
}

const account = (id: string) => ({ id }) as User

const report = (languages: string[] = []): SyncReport => ({
  pushed: 0,
  pulled: 0,
  documents: 0,
  languages,
  watermarks: {},
  serverWords: 0,
  serverDocuments: 0,
  localWords: 0,
  occurrencePush: [],
})

let storage: MemoryStorage
let originalLocalStorage: Storage | undefined

// 시험 중에 동기화 함수를 갈아 끼우므로, 각 시험은 진짜 동작으로 시작한다
const realSyncNow = useSyncStore.getState().syncNow
const realSyncQuietly = useSyncStore.getState().syncQuietly
const realClaimLocalData = useSyncStore.getState().claimLocalData
const realKeepLocalOnly = useSyncStore.getState().keepLocalOnly

beforeEach(() => {
  storage = new MemoryStorage()
  const globals = globalThis as { localStorage?: Storage }
  originalLocalStorage = globals.localStorage
  globals.localStorage = storage as unknown as Storage

  useAuthStore.setState({ user: null, restoring: false, error: null, code: '', codeSent: false })
  useLanguagesStore.setState({ enrolled: [], ready: false })
  useSyncStore.setState({
    status: 'local',
    lastSyncedAt: null,
    error: null,
    dirty: false,
    pendingByStore: {},
    notice: null,
    report: null,
    accountReady: false,
    readyForUserId: null,
    accountBlocked: false,
    claimNeeded: false,
    localOnly: true,
    syncNow: realSyncNow,
    syncQuietly: realSyncQuietly,
    claimLocalData: realClaimLocalData,
    keepLocalOnly: realKeepLocalOnly,
  })
  vi.mocked(syncOnce).mockReset()
})

afterEach(() => {
  const globals = globalThis as { localStorage?: Storage }
  if (originalLocalStorage === undefined) delete globals.localStorage
  else globals.localStorage = originalLocalStorage
  vi.restoreAllMocks()
})

describe('동기화 idle 대기', () => {
  it('동기화가 한 번도 시작되지 않았으면 바로 resolve 된다', async () => {
    await expect(waitForSyncIdle()).resolves.toBeUndefined()
  })
})

describe('소유자와 계정으로 정한 동기화 범위', () => {
  it('로그인하지 않았으면 동기화하지 않고 기기 범위다', () => {
    expect(ownerSyncState(null, null)).toEqual({
      canSync: false,
      accountBlocked: false,
      claimNeeded: false,
      localOnly: true,
    })
    expect(ownerSyncState({ kind: 'user', userId: 'user-a' }, null)).toEqual({
      canSync: false,
      accountBlocked: false,
      claimNeeded: false,
      localOnly: true,
    })
  })

  it('같은 계정의 소유자면 동기화한다', () => {
    expect(ownerSyncState({ kind: 'user', userId: 'user-a' }, 'user-a')).toEqual({
      canSync: true,
      accountBlocked: false,
      claimNeeded: false,
      localOnly: false,
    })
  })

  it('다른 계정의 소유자면 막는다 — 남의 기록을 올리지 않는다', () => {
    expect(ownerSyncState({ kind: 'user', userId: 'user-a' }, 'user-b')).toEqual({
      canSync: false,
      accountBlocked: true,
      claimNeeded: false,
      localOnly: true,
    })
  })

  /**
   * '이 기기만 쓰기' 는 이미 내린 결정이다. 계정이 로그인되어 있어도 다시 묻지 않고
   * 동기화도 하지 않는다.
   */
  it('이 기기만 쓰기를 고른 소유자는 묻지도 동기화하지도 않는다', () => {
    expect(ownerSyncState({ kind: 'local', kept: true }, 'user-a')).toEqual({
      canSync: false,
      accountBlocked: false,
      claimNeeded: false,
      localOnly: true,
    })
  })

  it('아직 넘겨받지 않은 기기 소유자는 넘겨받기를 묻는다', () => {
    expect(ownerSyncState({ kind: 'local', kept: false }, 'user-a')).toEqual({
      canSync: false,
      accountBlocked: false,
      claimNeeded: true,
      localOnly: true,
    })
    expect(ownerSyncState({ kind: 'local' }, 'user-a')).toEqual({
      canSync: false,
      accountBlocked: false,
      claimNeeded: true,
      localOnly: true,
    })
    expect(ownerSyncState(null, 'user-a')).toEqual({
      canSync: false,
      accountBlocked: false,
      claimNeeded: true,
      localOnly: true,
    })
  })
})

/**
 * 준비됐다는 사실만으로는 부족하다 — **누구의** 준비인지까지 맞아야 한다.
 *
 * `accountReady` 는 효과 안에서 거짓으로 돌아간다. A 의 확인이 끝난 상태에서
 * B 가 로그인하면, 효과가 돌기 전 한 번의 렌더가 남는다. 그 한 번에 A 의 문서·
 * 단어장이 보이면 공유 기기의 경계가 무너진다.
 */
describe('계정 게이트는 확인한 사용자와 지금 사용자가 같을 때만 열린다', () => {
  it('확인한 사용자와 지금 사용자가 같으면 연다', () => {
    expect(isAccountGateReady(true, 'user-a', 'user-a')).toBe(true)
    // 로그아웃 상태도 하나의 확인 결과다
    expect(isAccountGateReady(true, null, null)).toBe(true)
  })

  it('A 를 확인한 뒤 B 로 바뀌면 아직 열지 않는다', () => {
    expect(isAccountGateReady(true, 'user-a', 'user-b')).toBe(false)
  })

  it('아직 확인하지 않았거나 로그아웃 확인만 했으면 열지 않는다', () => {
    expect(isAccountGateReady(false, 'user-a', 'user-a')).toBe(false)
    expect(isAccountGateReady(true, null, 'user-a')).toBe(false)
  })
})

describe('계정 하나에 대해서만 동기화한다', () => {
  it('같은 계정의 소유자면 참이다', () => {
    writeLocalOwner({ kind: 'user', userId: 'user-a' }, storage)
    expect(canSyncForUser('user-a', storage)).toBe(true)
  })

  it('다른 계정의 소유자면 거짓이다', () => {
    writeLocalOwner({ kind: 'user', userId: 'user-a' }, storage)
    expect(canSyncForUser('user-b', storage)).toBe(false)
  })

  it('기기 소유자이거나 소유자가 없으면 거짓이다', () => {
    expect(canSyncForUser('user-a', storage)).toBe(false)

    writeLocalOwner({ kind: 'local' }, storage)
    expect(canSyncForUser('user-a', storage)).toBe(false)

    writeLocalOwner({ kind: 'local', kept: true }, storage)
    expect(canSyncForUser('user-a', storage)).toBe(false)
  })

  it('망가진 소유자 표시는 없는 것으로 보고 거짓이다', () => {
    storage.setItem(LOCAL_OWNER_KEY, JSON.stringify({ kind: 'user' }))
    expect(canSyncForUser('user-a', storage)).toBe(false)

    storage.setItem(LOCAL_OWNER_KEY, 'not json')
    expect(canSyncForUser('user-a', storage)).toBe(false)
  })

  it('저장소를 읽지 못하면 거짓이다 — 모르면 동기화하지 않는다', () => {
    expect(canSyncForUser('user-a', explodingRead())).toBe(false)
  })
})

describe('소유자 초기화 순서', () => {
  /**
   * 늦게 끝난 로그아웃 초기화가 나중에 시작한 로그인을 덮어쓰면, 계정에 묶인 기기가
   * 주인 없는 기기로 되돌아간다. 그러면 다음 계정이 그 기록을 넘겨받을 수 있다.
   * 초기화는 시작한 순서대로 실행되어 마지막 로그인이 최종 소유자가 되어야 한다.
   */
  it('겹친 초기화는 호출 순서대로 실행되어 나중 계정이 이긴다', async () => {
    let releaseFirst: (value: boolean) => void = () => {}
    const firstProbe = new Promise<boolean>((resolve) => {
      releaseFirst = resolve
    })

    // 먼저 시작한 로그아웃 초기화가 느리게 끝난다
    const first = initializeLocalOwner(null, {
      storage,
      hasLocalData: () => firstProbe,
    })
    // 그 사이 로그인 초기화가 시작된다 — 이쪽이 최종 소유자가 되어야 한다
    const second = initializeLocalOwner('user-b', {
      storage,
      hasLocalData: async () => false,
    })

    let secondFinished = false
    void second.then(() => {
      secondFinished = true
    })
    await Promise.resolve()

    // 첫 초기화가 끝나기 전에 두 번째가 먼저 쓸 수 없다
    const secondFinishedEarly = secondFinished
    releaseFirst(true)
    const [firstOwner, secondOwner] = await Promise.all([first, second])

    expect(secondFinishedEarly).toBe(false)
    expect(firstOwner).toEqual({ kind: 'local' })
    expect(secondOwner).toEqual({ kind: 'user', userId: 'user-b' })
    expect(readLocalOwner(storage)).toEqual({ kind: 'user', userId: 'user-b' })
  })
})

describe('기기 기록 넘겨받기', () => {
  it('지금 로그인한 계정이 아니면 아무것도 하지 않는다', () => {
    useAuthStore.setState({ user: account('user-a') })
    writeLocalOwner({ kind: 'local' }, storage)

    useSyncStore.setState({ claimNeeded: true, localOnly: true })
    useSyncStore.getState().claimLocalData('user-b')

    expect(readLocalOwner(storage)).toEqual({ kind: 'local', kept: false })
    expect(useSyncStore.getState().claimNeeded).toBe(true)
  })

  /**
   * 다른 계정의 표시가 남아 있을 때 넘겨받으면 그 계정의 기록이 새 계정으로 올라간다.
   * 이 갈래에는 넘겨받기라는 선택지가 없다 — 로그아웃과 초기화뿐이다.
   */
  it('다른 계정의 소유자는 절대 넘겨받지 않는다', () => {
    useAuthStore.setState({ user: account('user-b') })
    writeLocalOwner({ kind: 'user', userId: 'user-a' }, storage)
    const quiet = vi.fn(async () => {})
    useSyncStore.setState({ claimNeeded: true, localOnly: true, syncQuietly: quiet })

    useSyncStore.getState().claimLocalData('user-b')

    expect(readLocalOwner(storage)).toEqual({ kind: 'user', userId: 'user-a' })
    expect(useSyncStore.getState().claimNeeded).toBe(true)
    expect(quiet).not.toHaveBeenCalled()
  })

  it('주인 없는 기기 기록을 계정에 붙이고 동기화를 시작한다', () => {
    useAuthStore.setState({ user: account('user-a') })
    const quiet = vi.fn(async () => {})
    useSyncStore.setState({ claimNeeded: true, localOnly: true, syncQuietly: quiet })

    useSyncStore.getState().claimLocalData('user-a')

    expect(readLocalOwner(storage)).toEqual({ kind: 'user', userId: 'user-a' })
    expect(useSyncStore.getState().claimNeeded).toBe(false)
    expect(useSyncStore.getState().localOnly).toBe(false)
    expect(useSyncStore.getState().accountBlocked).toBe(false)
    expect(quiet).toHaveBeenCalledTimes(1)
  })

  it('이 기기만 쓰기를 고른 뒤에도 계정에 붙일 수 있다', () => {
    useAuthStore.setState({ user: account('user-a') })
    writeLocalOwner({ kind: 'local', kept: true }, storage)
    const quiet = vi.fn(async () => {})
    useSyncStore.setState({ claimNeeded: false, localOnly: true, syncQuietly: quiet })

    useSyncStore.getState().claimLocalData('user-a')

    expect(readLocalOwner(storage)).toEqual({ kind: 'user', userId: 'user-a' })
    expect(quiet).toHaveBeenCalledTimes(1)
  })
})

describe('이 기기만 쓰기', () => {
  it('결정을 저장하고 다시 묻지 않는다', () => {
    writeLocalOwner({ kind: 'local' }, storage)
    useSyncStore.setState({ claimNeeded: true, localOnly: true })

    useSyncStore.getState().keepLocalOnly()

    const saved = readLocalOwner(storage)
    expect(saved).toEqual({ kind: 'local', kept: true })
    // 새로 고침해도 같은 판정이어야 한다 — 다시 묻지 않는다
    expect(ownerSyncState(saved, 'user-a')).toEqual({
      canSync: false,
      accountBlocked: false,
      claimNeeded: false,
      localOnly: true,
    })
    expect(useSyncStore.getState()).toMatchObject({
      claimNeeded: false,
      localOnly: true,
      accountBlocked: false,
      status: 'local',
      error: null,
    })
  })

  it('넘겨받기를 묻는 상태가 아니면 아무것도 하지 않는다', () => {
    writeLocalOwner({ kind: 'local' }, storage)
    useSyncStore.setState({ claimNeeded: false, localOnly: true })

    useSyncStore.getState().keepLocalOnly()

    expect(readLocalOwner(storage)).toEqual({ kind: 'local', kept: false })
  })

  /**
   * 막힌 상태에는 '이 기기만 쓰기' 라는 출구가 없다. 여기서 소유자를 기기로 바꾸면
   * 다른 계정의 기록이 이 기기에 남은 채 새 계정처럼 보이게 된다.
   */
  it('다른 계정의 소유자로 막혔을 때는 아무것도 하지 않는다', () => {
    writeLocalOwner({ kind: 'user', userId: 'user-a' }, storage)
    useSyncStore.setState({ accountBlocked: true, claimNeeded: false, localOnly: true })

    useSyncStore.getState().keepLocalOnly()

    expect(readLocalOwner(storage)).toEqual({ kind: 'user', userId: 'user-a' })
    expect(useSyncStore.getState()).toMatchObject({
      accountBlocked: true,
      claimNeeded: false,
      localOnly: true,
    })
  })
})

describe('동기화 입구', () => {
  it('로그인하지 않았으면 동기화를 부르지 않고 기기 상태로 돌아간다', async () => {
    useSyncStore.setState({ status: 'synced', lastSyncedAt: '2026-01-01T00:00:00.000Z' })

    await useSyncStore.getState().syncNow()

    expect(syncOnce).not.toHaveBeenCalled()
    expect(useSyncStore.getState()).toMatchObject({ status: 'local', error: null })
  })

  it('소유자가 없으면 넘겨받기 전에는 동기화하지 않는다', async () => {
    useAuthStore.setState({ user: account('user-a') })
    useSyncStore.setState({ status: 'synced' })

    await useSyncStore.getState().syncNow()

    expect(syncOnce).not.toHaveBeenCalled()
    expect(useSyncStore.getState().status).toBe('local')
  })

  it('다른 계정의 소유자면 조용한 동기화도 부르지 않는다', async () => {
    writeLocalOwner({ kind: 'user', userId: 'user-a' }, storage)
    useAuthStore.setState({ user: account('user-b') })
    useSyncStore.setState({ status: 'synced' })

    await useSyncStore.getState().syncQuietly()

    expect(syncOnce).not.toHaveBeenCalled()
    expect(useSyncStore.getState().status).toBe('local')
  })

  it('기기 전용 소유자면 동기화하지 않는다', async () => {
    writeLocalOwner({ kind: 'local', kept: true }, storage)
    useAuthStore.setState({ user: account('user-a') })
    useSyncStore.setState({ status: 'synced' })

    await useSyncStore.getState().syncNow()

    expect(syncOnce).not.toHaveBeenCalled()
    expect(useSyncStore.getState().status).toBe('local')
  })
})

describe('동기화 도중 계정이 바뀌면', () => {
  it('새 계정의 화면·워터마크를 건드리지 않는다', async () => {
    writeLocalOwner({ kind: 'user', userId: 'user-a' }, storage)
    useAuthStore.setState({ user: account('user-a') })
    useSyncStore.setState({ status: 'synced', lastSyncedAt: '2026-01-01T00:00:00.000Z' })
    const adopt = vi.spyOn(useLanguagesStore.getState(), 'adopt')

    vi.mocked(syncOnce).mockImplementation(async () => {
      useAuthStore.setState({ user: account('user-b') })
      return report(['ja'])
    })

    await useSyncStore.getState().syncQuietly()

    expect(syncOnce).toHaveBeenCalledTimes(1)
    // 계정 A 의 결과를 계정 B 의 화면에 채택하지 않는다
    expect(adopt).not.toHaveBeenCalled()
    expect(useSyncStore.getState().lastSyncedAt).toBe('2026-01-01T00:00:00.000Z')

    // 계정 A 의 워터마크도 남기지 않는다 — 다음에 A 로 돌아오면 처음부터 맞춘다
    const stored = JSON.parse(storage.getItem('lexi.syncState') ?? '{}') as Record<string, unknown>
    expect(stored['user-a']).toBeUndefined()
  })

  /**
   * `syncOnce` 뒤의 첫 확인만으로는 부족하다. 화면 스토어를 읽는 동안에도 계정이
   * 바뀔 수 있고, 그때 나머지 읽기와 성공 상태를 그대로 적용하면 B 화면에 A 의
   * 보고서가 남는다.
   */
  it('화면 스토어를 읽는 도중 계정이 바뀌면 나머지 읽기와 결과를 멈춘다', async () => {
    writeLocalOwner({ kind: 'user', userId: 'user-a' }, storage)
    useAuthStore.setState({ user: account('user-a') })
    useLanguagesStore.setState({ enrolled: ['ja'], ready: true })
    useSyncStore.setState({
      status: 'synced',
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
      report: null,
    })
    vi.mocked(syncOnce).mockResolvedValue(report(['ja']))

    const documentsLoad = vi
      .spyOn(useDocumentsStore.getState(), 'load')
      .mockImplementation(async () => {
        useAuthStore.setState({ user: account('user-b') })
      })
    const foldersLoad = vi
      .spyOn(useFoldersStore.getState(), 'load')
      .mockImplementation(async () => {})
    const wordStatesLoad = vi
      .spyOn(useWordStatesStore.getState(), 'loadLanguage')
      .mockImplementation(async () => {})
    const occurrencesLoad = vi
      .spyOn(useOccurrencesStore.getState(), 'loadLanguage')
      .mockImplementation(async () => {})

    await useSyncStore.getState().syncQuietly()

    expect(documentsLoad).toHaveBeenCalledTimes(1)
    // 첫 읽기 뒤에 계정이 바뀌었으므로 나머지는 이 계정의 화면을 건드리지 않는다
    expect(foldersLoad).not.toHaveBeenCalled()
    expect(wordStatesLoad).not.toHaveBeenCalled()
    expect(occurrencesLoad).not.toHaveBeenCalled()
    expect(useSyncStore.getState().lastSyncedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(useSyncStore.getState().report).toBeNull()
  })
})
