import { useState } from 'react'

import { useAuthStore } from '../../app/stores/auth'
import { useTranslation } from '../../app/stores/settings'
import { resetLocalAccount } from '../../lib/storage/resetLocalAccount'
import { ConfirmDialog } from '../reader/ConfirmDialog'

/**
 * 다른 계정의 기록이 이 기기에 남아 있을 때의 전체 화면 잠금.
 *
 * 배너로는 부족하다 — 배너를 띄워도 뒤의 문서·단어장 화면은 그대로 보인다.
 * 이 기기의 로컬 데이터는 이전 계정의 것이므로, 새 계정이 그것을 읽지 못하게
 * 길 자체를 막는다. 빠져나갈 길은 둘뿐이다: 원래 계정으로 돌아가거나, 이
 * 브라우저의 로컬 데이터를 지우고 새 계정의 기기로 다시 시작하거나.
 */
export function AccountLock() {
  const t = useTranslation()
  const user = useAuthStore((s) => s.user)
  const signOut = useAuthStore((s) => s.signOut)

  const [confirming, setConfirming] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 잠금 중에 세션이 사라질 수 있다 — 그때는 화면을 그리지 않고 정상 흐름에 맡긴다
  if (!user) return null

  const reset = async () => {
    setConfirming(false)
    setResetting(true)
    setError(null)
    try {
      // 성공하면 새로고침된다 — 여기서 busy 를 풀면 잠깐 다시 눌린다
      await resetLocalAccount(user.id)
    } catch (cause) {
      // 지우지 못했으면 성공한 척하지 않는다. 새로고침도 하지 않는다
      setError(cause instanceof Error ? cause.message : String(cause))
      setResetting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-5 py-10">
      <div className="border-line bg-surface w-full max-w-sm rounded-xl border p-5">
        <p className="text-sm font-semibold">{t('account.blockedTitle')}</p>
        <p className="text-ink-muted mt-1 text-xs">{t('account.blockedBody')}</p>
        <p className="text-ink-muted mt-3 truncate text-xs">{user.email}</p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void signOut()}
            className="border-line hover:border-accent rounded-lg border px-3 py-1.5 text-sm"
          >
            {t('account.signOut')}
          </button>
          <button
            type="button"
            disabled={resetting}
            onClick={() => {
              setError(null)
              setConfirming(true)
            }}
            className="border-status-unknown text-status-unknown hover:bg-status-unknown-bg rounded-lg border px-3 py-1.5 text-sm disabled:opacity-40"
          >
            {t('account.resetLocal')}
          </button>
        </div>

        {error && <p className="text-status-unknown mt-3 text-xs break-words">{error}</p>}
      </div>

      {confirming && (
        <ConfirmDialog
          title={t('account.resetLocal')}
          body={t('account.resetLocalConfirm')}
          confirmLabel={t('account.resetLocal')}
          onConfirm={() => void reset()}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  )
}
