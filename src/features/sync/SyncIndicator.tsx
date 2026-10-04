import { useTranslation } from '../../app/stores/settings'
import { useAuthStore } from '../../app/stores/auth'
import { useSyncStore } from '../../app/stores/sync'

/**
 * 읽는 동안에도 저장됐는지 보이는 자리.
 *
 * 예전엔 설정 화면을 열어야만 알 수 있었다. 그래서 '창을 닫았는데 진도가 사라졌다'
 * 는 걸 알 방법이 없었다 — 잃었다는 사실조차, 언제인지도 몰랐다.
 *
 * **단어 상태가 바뀐 때만 말한다.**
 *
 * 저장은 문서를 열어도, 등장 기록을 계산해도, 제목을 바꿔도 생긴다. 그것까지
 * 알리면 읽는 내내 깜빡인다 — 있다는 사실이 곧 무시하게 된다. 사람들이 잃어버렸다고
 * 느낀 것은 진도, 즉 단어 상태였다. 그때만 말한다.
 *
 * 아무 문제가 없으면 아무것도 말하지 않는다 — 늘 보이면 늘 보이지 않게 된다.
 */
export function SyncIndicator() {
  const t = useTranslation()
  const signedIn = useAuthStore((s) => s.user !== null)
  const status = useSyncStore((s) => s.status)
  const wordStatesPending = useSyncStore((s) => s.pendingByStore.wordStates ?? 0)

  if (!signedIn) return null

  const failed = status === 'error'
  // 진도가 아니라 다른 저장은 여기서 말하지 않는다
  const pending = wordStatesPending > 0

  if (!failed && !pending) return null

  return (
    <span
      role="status"
      aria-live="polite"
      className={`shrink-0 text-[10px] ${
        failed ? 'text-status-unknown' : 'text-status-unsure'
      }`}
    >
      {failed ? t('sync.failed') : t('sync.pending')}
    </span>
  )
}
