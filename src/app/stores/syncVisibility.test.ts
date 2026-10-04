import { describe, expect, it } from 'vitest'

import {
  markSynced,
  noticeActive,
  NOTICE_MS,
  statusKind,
  type SyncNotice,
} from './syncVisibility'

const now = 1_000_000
const notice = (over: Partial<SyncNotice> = {}): SyncNotice => ({
  until: now + NOTICE_MS,
  synced: false,
  ...over,
})

/** '잠깐 말하기' 가 열려 있는가 / 닫혔는가 — 판단은 시간을 직접 보지 않는다 */
const OPEN = true
const CLOSED = false

/**
 * 무언가 말할 것인가.
 *
 * 자동 동기화를 조용히 하자는 요구와, 진도가 안 올라갔을 때 반드시 말하라는 요구가
 * 함께 있다. 둘 다 만족하려면 '사람이 한 행동' 과 '실패' 만 말해야 한다.
 */
describe('저장 상태 말하기', () => {
  it('평범하면 아무것도 말하지 않는다 — 자동 동기화는 뒤에서 조용히', () => {
    expect(statusKind({ status: 'synced', pending: 0, noticeActive: CLOSED })).toBe('hidden')
    expect(statusKind({ status: 'syncing', pending: 0, noticeActive: CLOSED })).toBe('hidden')
  })

  /**
   * 실패는 끝까지 말한다.
   *
   * 'Not synced yet' 과 'Save failed' 가 계속 떠야 한다. 실제로 못 보냈다는 사실을
   * 모른 채 진도를 잃는 것이 이 앱에서 가장 나쁜 일이다.
   */
  it('실패는 시간이 지나도 계속 말한다', () => {
    expect(statusKind({ status: 'error', pending: 0, noticeActive: CLOSED })).toBe('failed')
    expect(statusKind({ status: 'error', pending: 3, noticeActive: OPEN })).toBe('failed')
  })

  it('단어 상태를 바꾸고 있는 동안 말한다', () => {
    expect(statusKind({ status: 'syncing', pending: 1, noticeActive: OPEN })).toBe('syncing')
    expect(statusKind({ status: 'synced', pending: 1, noticeActive: OPEN })).toBe('pending')
  })

  /**
   * 밀려 있으면 시간이 지나도 계속 말한다.
   *
   * 시간이 지나서 'Not synced yet' 이 사라지면, 사용자는 저장이 끝났다고 믿는다.
   * 실제로는 기기 안에만 있다 — 가장 나쁜 경우다.
   */
  it('알림 시간이 지났는데 밀려 있으면 계속 말한다', () => {
    expect(statusKind({ status: 'synced', pending: 2, noticeActive: CLOSED })).toBe('pending')
  })

  it('보내고 나면 잠깐 올라갔다고 말한다', () => {
    expect(statusKind({ status: 'synced', pending: 0, noticeActive: OPEN })).toBe('synced')
  })

  it('확인 시간이 지나면 조용해진다', () => {
    expect(statusKind({ status: 'synced', pending: 0, noticeActive: CLOSED })).toBe('hidden')
  })

  it('로그인하지 않은 로컬 상태는 말하지 않는다', () => {
    expect(statusKind({ status: 'local', pending: 0, noticeActive: CLOSED })).toBe('hidden')
  })
})

describe('잠깐 말하기 시간이 남았는지', () => {
  it('남았으면 열려 있다', () => {
    expect(noticeActive(notice(), now)).toBe(true)
  })

  it('지났으면 닫혔다 — 조용해져야 한다', () => {
    expect(noticeActive(notice(), now + NOTICE_MS + 1)).toBe(false)
  })

  it('알림이 없으면 닫혀 있다', () => {
    expect(noticeActive(null, now)).toBe(false)
  })
})

describe('보냈다고 표시하기', () => {
  it('몇 초 더 남긴다 — 올라갔다고 알아야 안심한다', () => {
    const marked = markSynced(notice(), now)
    expect(marked?.synced).toBe(true)
    expect(marked?.until ?? 0).toBeGreaterThanOrEqual(now)
  })

  it('이미 표시한 것을 다시 더 늘리지 않는다 — 같은 창을 계속 늘리면 조용해지지 않는다', () => {
    const first = markSynced(notice(), now)
    const second = markSynced(first, now + 10_000)
    expect(second?.until).toBe(first?.until)
  })

  it('알림이 없으면 새로 만들지 않는다 — 조용함이 기본이다', () => {
    expect(markSynced(null, now)).toBeNull()
  })
})