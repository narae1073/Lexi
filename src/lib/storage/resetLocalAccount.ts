import { writeLocalOwner, type OwnerStorage } from './accountOwner'
import { deleteLocalDatabase } from './localDb'

/**
 * 계정별로만 남는 localStorage 키.
 *
 * `lexi.purged` 는 이 기기에서 완전 삭제한 문서 목록, `lexi.languages` 는 온보딩
 * 선택, `lexi.syncState` 는 계정별 워터마크다. 모두 계정 데이터에 딸린 것이라
 * 초기화하면 함께 사라져야 한다.
 *
 * `lexi.settings`(테마·글자 크기·쪽 크기)는 기기 취향이므로 **남긴다.**
 */
const ACCOUNT_KEYS = ['lexi.purged', 'lexi.languages', 'lexi.syncState'] as const

/**
 * 이 브라우저의 로컬 학습 데이터를 지우고 새 계정의 기기로 다시 세운다.
 *
 * 다른 계정의 데이터가 남아 잠긴 기기에서, 그 계정으로 돌아가지 않고도 이 기기를
 * 새 계정에 넘기는 유일한 길이다. DB 삭제가 실패하면(다른 탭이 잡고 있으면)
 * 소유자도 키도 건드리지 않고 그대로 거절한다 — 절반만 지운 상태로 새로고침하면
 * 무엇이 남았는지 알 수 없다. 기본값은 새로고침이고, 시험에서는 주입한다.
 */
export async function resetLocalAccount(
  userId: string,
  options: { storage?: OwnerStorage; reload?: () => void } = {},
): Promise<void> {
  await deleteLocalDatabase()

  const storage = options.storage ?? globalThis.localStorage
  for (const key of ACCOUNT_KEYS) storage.removeItem(key)
  // 소유자 표시를 새 계정으로 바꿔야 새로고침 뒤 잠금이 다시 걸리지 않는다
  writeLocalOwner({ kind: 'user', userId }, storage)

  const reload = options.reload ?? (() => window.location.reload())
  reload()
}
