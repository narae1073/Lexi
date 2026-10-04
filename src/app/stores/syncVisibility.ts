import type { SyncStatus } from './sync'

/**
 * 저장 상태를 언제 사람에게 말할지.
 *
 * 자동 동기화는 뒤에서 조용히 하되, 사람이 한 행동의 결과는 알려야 한다. 이 분기를
 * 순수 함수로 빼 둔 이유가 있다 — 화면이 아니라 '무엇을 말할 것인가' 라는 판단이라
 * 서버나 브라우저 없이도 시험할 수 있어야 하기 때문이다.
 *
 * 규칙
 * - 실패는 끝까지 말한다. 실제로 못 보냈다는 사실이 가장 중요하다
 * - 사람이 단어 상태를 바꾸거나 '지금 동기화' 를 눌렀으면 몇 초 동안 말한다
 * - 그 외에는 말하지 않는다. 자동으로 아무것도 하지 않은 걸 알릴 필요가 없다
 * - 밀려 있으면 시간이 지나도 계속 말한다 — 가려진 '진도가 없다' 는 곧 잃어버림이다
 */
export type SyncNotice = {
  /** 여기까지는 보인다 — 사람이 한 행동의 결과라 잠깐 알려 준다 */
  until: number
  /** 이 알림이 낼 이후 실제로 올라갔는가 */
  synced: boolean
}

/**
 * '잠깐 말하기' 가 아직 남았는지.
 *
 * 시간을 직접 부르지 않는다 — 그 판단은 갱신 타이머가 하고, 여기엔 결과만 넘긴다.
 * 그래야 그릴 때마다 같은 결과가 나오고, 무엇이 말할지试验할 수 있다.
 */
export function noticeActive(notice: SyncNotice | null, now: number): boolean {
  return notice !== null && now < notice.until
}

/** 사람이 한 행동의 결과를 몇 초 동안 말할지 */
export const NOTICE_MS = 4_000

/** 보냈다는 확인을 조금 더 남긴다 — 올라갔다고 알아야 안심한다 */
const CONFIRM_MS = 1_500

export type StatusKind = 'hidden' | 'pending' | 'syncing' | 'synced' | 'failed'

export function statusKind({
  status,
  pending,
  noticeActive,
}: {
  status: SyncStatus
  /** 아직 서버에 못 올린 단어 상태 변경 수 */
  pending: number
  /** '잠깐 말하기' 시간이 아직 남았는가 — 시간을 직접 보지 않고 받는다 */
  noticeActive: boolean
}): StatusKind {
  // 실패는 사람이 해결할 때까지 계속 보인다
  if (status === 'error') return 'failed'

  /**
   * 밀려 있으면 말한다 — 시간이 지나도 계속.
   *
   * 조용해진 'Not synced yet' 은 곧 잃어버림이다. 실제로 누구도 안 보낸 상태인데
   * 화면이 말하지 않으면, 사용자는 저장이 끝났다고 믿는다.
   */
  if (pending > 0) return status === 'syncing' ? 'syncing' : 'pending'

  // 다 올라갔고, 방금 한 행동의 결과라 잠깐 말할 시간일 때만
  if (noticeActive) return 'synced'

  return 'hidden'
}

/** 보냈을 때 알림을 확인 처리한다 — 몇 초 더 '올아갔다' 고 말하고 조용해진다 */
export function markSynced(notice: SyncNotice | null, now: number): SyncNotice | null {
  if (!notice || notice.synced) return notice
  return { synced: true, until: Math.max(notice.until, now + CONFIRM_MS) }
}