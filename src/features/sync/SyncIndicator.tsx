import { useTranslation } from '../../app/stores/settings'
import { useAuthStore } from '../../app/stores/auth'
import { useSyncStore, useSyncStatus } from '../../app/stores/sync'

/**
 * 읽는 동안에도 저장됐는지 보이는 자리.
 *
 * 예전엔 설정 화면을 열어야만 알 수 있었다. 그래서 '창을 닫았는데 진도가 사라졌다'
 * 는 걸 알 방법이 없었다.
 *
 * **자동 동기화는 말하지 않는다.**
 *
 * 저장은 문서를 열 때도, 등장 기록을 계산할 때도 생긴다. 그것까지 알리면 읽는 내내
 * 깜빡여 곧 무시하게 된다 — 있다는 사실이 곧 없는 일이 된다. 사람이 한 행동의
 * 결과(단어 상태 변경, '지금 동기화')만 잠깐 말하고, 실제로 못 보냈을 때만 계속
 * 말한다.
 */
export function SyncIndicator() {
  const t = useTranslation()
  const signedIn = useAuthStore((s) => s.user !== null)
  const status = useSyncStore((s) => s.status)
  const pending = useSyncStore((s) => s.pendingByStore.wordStates ?? 0)
  const notice = useSyncStore((s) => s.notice)

  // 시간 의존 판단이라 시간이 지나면 한 번 더 그려 조용해지는 시점을 만든다
  const kind = useSyncStatus(status, notice, pending)

  if (!signedIn || kind === 'hidden') return null

  return (
    <span
      role="status"
      aria-live="polite"
      className={`shrink-0 text-[10px] ${
        kind === 'failed' || kind === 'pending' ? 'text-status-unsure' : 'text-ink-muted'
      }`}
    >
      {t(`sync.${kind}`)}
    </span>
  )
}