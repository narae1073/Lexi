import { useTranslation } from '../../app/stores/settings'
import { useAuthStore } from '../../app/stores/auth'
import { useSyncStore } from '../../app/stores/sync'

/**
 * 읽는 동안에도 저장됐는지 보이는 자리.
 *
 * 예전엔 설정 화면을 열어야만 알 수 있었다. 그래서 '창을 닫았는데 진도가 사라졌다'
 * 는 걸 알 방법이 없었다 — 잃었다는 사실조차, 언제인지도 몰랐다.
 *
 * 아무 문제가 없으면 아무것도 말하지 않는다. 늘 보이면 늘 보이지 않게 된다 —
 * 그때 이 자리가 없는 것처럼 느껴져서, 정말 멈춘 때에야 눈에 띈다.
 */
export function SyncIndicator() {
  const t = useTranslation()
  const signedIn = useAuthStore((s) => s.user !== null)
  const status = useSyncStore((s) => s.status)
  const dirty = useSyncStore((s) => s.dirty)

  if (!signedIn) return null

  const failed = status === 'error'
  const syncing = status === 'syncing'

  // 저장은 끝났는데 아직 서버로 못 보냈다 — 이게 바로 잃을 수 있는 구간이다
  if (!failed && !syncing && !dirty) return null

  return (
    <span
      role="status"
      aria-live="polite"
      className={`shrink-0 text-[10px] ${
        failed ? 'text-status-unknown' : syncing ? 'text-ink-muted' : 'text-status-unsure'
      }`}
    >
      {failed
        ? t('sync.failed')
        : syncing
          ? t('sync.syncing')
          : t('sync.pending')}
    </span>
  )
}