import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  STORES,
  deleteLocalDatabase,
  hasLocalLearningData,
  idbCount,
  idbDelete,
  idbGetAll,
  idbPut,
  onLocalWrite,
} from './localDb'
import type { StoreName } from './localDb'

/**
 * 저장이 끝났음을 알리는 신호.
 *
 * 이 신호가 없으면 동기화는 로그인·앱 시작·온라인 복귀에만 돈다. 그래서 단어 상태를
 * 바꿔도 서버엔 올라가지 않았다 — 창을 닫으면 그대로 사라졌다.
 *
 * 쓰기는 tx() 하나를 지나므로 거기서 한 번만 알린다. 어디서 저장하든 따라온다는
 * 뜻이고, 앞으로 기능을 추가해도 동기화에서 빠지지 않는다.
 */
describe('저장 완료 알림', () => {
  beforeEach(async () => {
    // 테스트 사이에 남은 데이터를 비운다
    await Promise.all([
      idbDelete(STORES.documents, 'doc-1'),
      idbDelete(STORES.wordStates, 'en::run'),
      idbDelete(STORES.responseCache, 'k'),
    ]).catch(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('문서를 저장하면 알린다', async () => {
    const seen: string[] = []
    const off = onLocalWrite((store) => seen.push(store))

    await idbPut(STORES.documents, { id: 'doc-1', title: '제목' })
    await Promise.resolve()

    expect(seen).toContain(STORES.documents)
    off()
  })

  it('단어 상태를 저장하면 알린다', async () => {
    const seen: string[] = []
    const off = onLocalWrite((store) => seen.push(store))

    await idbPut(STORES.wordStates, { languageCode: 'en', lemma: 'run' })
    await Promise.resolve()

    expect(seen).toContain(STORES.wordStates)
    off()
  })

  /**
   * 기기 안에서만 쓰는 저장은 알리지 않는다.
   *
   * 응답 캐시는 재사용용이고 documentMeta 는 계산 기록이다. 이들이 신호를 보내면
   * 사전 하나를 볼 때마다 서버를 두드린다.
   */
  it('기기 안에서만 쓰는 저장은 알리지 않는다', async () => {
    const seen: string[] = []
    const off = onLocalWrite((store) => seen.push(store))

    await idbPut(STORES.responseCache, { key: 'k', value: 1 })
    await idbPut(STORES.documentMeta, { documentId: 'doc-1', lemmaVersion: 3 })
    await Promise.resolve()

    expect(seen).toEqual([])
    off()
  })

  it('읽기는 알리지 않는다 — 조회를 할 때마다 동기화가 돌면 안 된다', async () => {
    const seen: string[] = []
    const off = onLocalWrite((store) => seen.push(store))

    await idbGetAll(STORES.documents)
    await Promise.resolve()

    expect(seen).toEqual([])
    off()
  })

  it('지워도 알린다 — 휴지통의 완전 삭제는 사라진 것을 뜻한다', async () => {
    const seen: string[] = []
    await idbPut(STORES.documents, { id: 'doc-1', title: '제목' })
    const off = onLocalWrite((store) => seen.push(store))

    await idbDelete(STORES.documents, 'doc-1')
    await Promise.resolve()

    expect(seen).toContain(STORES.documents)
    off()
  })

  /**
   * 알림이 실패해도 저장은 끝난 일이다.
   *
   * 듣는 쪽이 던진 오류로 저장이 흔들리면, 알림을 넣은 기능 하나가 데이터 전체를
   * 막을 수 있다.
   */
  it('듣는 쪽이 실패해도 저장은 막히지 않는다', async () => {
    const off = onLocalWrite(() => {
      throw new Error('알림 실패')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(idbPut(STORES.documents, { id: 'doc-1' })).resolves.toBeTruthy()
    expect(await idbGetAll(STORES.documents)).toHaveLength(1)
    off()
  })

  it('끄면 더 이상 오지 않는다', async () => {
    const seen: string[] = []
    const off = onLocalWrite((store) => seen.push(store))
    off()

    await idbPut(STORES.documents, { id: 'doc-2' })
    await Promise.resolve()

    expect(seen).toEqual([])
  })
})

/**
 * 기기에 학습 데이터가 있는지 세고, 계정 전환·초기화 때 통째로 지운다.
 *
 * owner 마커가 없는 기기(익명으로 쓰던 기기)를 새 계정에 붙일지 정하려면
 * "이 기기에 남은 학습 데이터가 있는가" 를 알아야 한다. 초기화는 반대로
 * 남김없이 지워야 한다 — 다음 로그인에서 옛 데이터가 새 계정으로 새지 않는다.
 */
describe('로컬 학습 데이터 존재 확인과 초기화', () => {
  beforeEach(async () => {
    await deleteLocalDatabase()
  })

  it('저장된 것이 없으면 세는 값은 0 이다', async () => {
    expect(await idbCount(STORES.documents)).toBe(0)
    expect(await idbCount(STORES.wordStates)).toBe(0)
  })

  it('문서를 하나 저장하면 세는 값은 1 이고 학습 데이터가 있다', async () => {
    await idbPut(STORES.documents, { id: 'doc-1', title: '제목' })

    expect(await idbCount(STORES.documents)).toBe(1)
    await expect(hasLocalLearningData()).resolves.toBe(true)
  })

  /**
   * 응답 캐시와 documentMeta 는 학습 데이터가 아니다.
   *
   * 사전을 한 번 본 것만으로 "이 기기에 쓸 만한 데이터가 있다" 고 판단하면
   * 빈 기기를 계정에 붙이는 셈이 된다.
   */
  it('응답 캐시만 있으면 학습 데이터가 없다', async () => {
    await idbPut(STORES.responseCache, { key: 'k', value: 1 })
    await idbPut(STORES.documentMeta, { documentId: 'doc-1', lemmaVersion: 3 })

    await expect(hasLocalLearningData()).resolves.toBe(false)
  })

  it('초기화하면 문서와 단어 상태가 비고 세는 값도 0 이 된다', async () => {
    await idbPut(STORES.documents, { id: 'doc-1', title: '제목' })
    await idbPut(STORES.wordStates, { languageCode: 'en', lemma: 'run' })

    await deleteLocalDatabase()

    expect(await idbCount(STORES.documents)).toBe(0)
    expect(await idbCount(STORES.wordStates)).toBe(0)
    await expect(hasLocalLearningData()).resolves.toBe(false)
  })

  it('한 번 더 초기화해도 실패하지 않는다', async () => {
    await deleteLocalDatabase()
    await expect(deleteLocalDatabase()).resolves.toBeUndefined()
  })

  /**
   * 초기화 중에 백그라운드 읽기가 끼어들면 안 된다.
   *
   * 그 읽기가 새 연결을 열면 deleteLocalDatabase 는 그 연결을 모른 채
   * 삭제를 기다리다 blocked 로 끝난다. 초기화가 끝날 때까지는 열지 않고
   * 바로 거절해야 호출자가 재시도할 수 있다.
   */
  it('초기화가 진행 중이면 새 연결을 열지 않고 거절한다', async () => {
    await idbPut(STORES.documents, { id: 'doc-1', title: '제목' })

    const reset = deleteLocalDatabase()

    await expect(idbCount(STORES.documents)).rejects.toThrow('초기화하는 중')
    await reset
  })

  /**
   * 다른 탭이 연결을 잡고 있으면 삭제는 blocked 로 끝난다.
   *
   * 이때 성공으로 보고하면 안 된다 — 데이터는 아직 그대로다. 삭제 요청은
   * 남아 있어 그 탭이 닫히면 나중에 완료될 수 있으므로, 호출자는 다른 탭을
   * 닫고 다시 시도해야 한다.
   */
  it('다른 탭이 연결을 잡고 있으면 성공으로 보고하지 않고 거절한다', async () => {
    const held = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('lexi', 6)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })

    await expect(deleteLocalDatabase()).rejects.toThrow('다른 탭')

    // 잡고 있던 탭이 닫히면 남아 있던 삭제 요청이 마저 진행된다 — 정리한다
    held.close()
    await waitForDatabaseDeletion()
  })

  /**
   * 없는 저장소를 세면 트랜잭션을 만들 때 바로 거절한다.
   *
   * 요청(request) 수준의 오류를 인위로 만들려면 IndexedDB 를 흉내 내야 해서
   * 취약하다. 여기서는 "오류가 나면 reject 하고 멈추지 않는다" 만 확인한다.
   */
  it('없는 저장소를 세면 거절한다', async () => {
    await expect(idbCount('missing' as StoreName)).rejects.toThrow()
  })
})

/** 남아 있던 삭제 요청이 끝나 데이터베이스가 사라질 때까지 기다린다. */
async function waitForDatabaseDeletion(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const databases = await indexedDB.databases()
    if (!databases.some((database) => database.name === 'lexi')) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('로컬 데이터베이스 삭제가 끝나지 않았습니다')
}