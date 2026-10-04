import { useState } from 'react'

import { authErrorKeyOrMessage } from '../../lib/authError'
import { showGoogleLogin } from '../../lib/flags'
import { isSupabaseConfigured } from '../../lib/supabase/client'
import { useAuthStore } from '../../app/stores/auth'
import { useSyncStore } from '../../app/stores/sync'
import { usePendingSummary, useSyncStatus } from '../../app/stores/sync'
import { useTranslation } from '../../app/stores/settings'

/**
 * 계정과 동기화 (plan.txt 1줄: 집에서든 밖에서든 이어서 학습).
 *
 * 로그인하지 않아도 앱은 다 쓴다. 그래서 여기서 실패해도 앱 전체가 막히면 안 되고,
 * 실제로 SyncUnavailable 이 나면 Supabase 미설정 안내만 보여준다.
 */
export function AccountPanel() {
  const t = useTranslation()
  const user = useAuthStore((s) => s.user)
  const restoring = useAuthStore((s) => s.restoring)
  const linkSent = useAuthStore((s) => s.linkSent)
  const authError = useAuthStore((s) => s.error)
  const sendMagicLink = useAuthStore((s) => s.sendMagicLink)
  const signInWithGoogle = useAuthStore((s) => s.signInWithGoogle)
  const signOut = useAuthStore((s) => s.signOut)
  const clearError = useAuthStore((s) => s.clearError)

  const status = useSyncStore((s) => s.status)
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt)
  const syncError = useSyncStore((s) => s.error)
  const pending = usePendingSummary()
  const notice = useSyncStore((s) => s.notice)
  const shown = useSyncStatus(status, notice, pending.count)
  const syncNow = useSyncStore((s) => s.syncNow)

  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)

  if (!isSupabaseConfigured) {
    return (
      <div>
        <p className="text-sm font-medium">{t('account.title')}</p>
        <p className="text-ink-muted mt-1 text-xs">{t('account.notConfigured')}</p>
      </div>
    )
  }

  if (restoring) {
    return (
      <div>
        <p className="text-sm font-medium">{t('account.title')}</p>
        <p className="text-ink-muted mt-1 text-xs">{t('account.checking')}</p>
      </div>
    )
  }

  if (user) {
    return (
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-medium">{t('account.title')}</p>
          <button
            type="button"
            onClick={() => void signOut()}
            className="text-ink-muted hover:text-ink text-xs"
          >
            {t('account.signOut')}
          </button>
        </div>
        <p className="text-ink-muted mt-1 truncate text-xs">{user.email}</p>

        <dl className="mt-3 space-y-1 text-xs">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-ink-muted">{t('account.syncStatus')}</dt>
            {/*
              살아 있는 상태를 그대로 보여 주면 사람이 판단할 수 없다.
              자동 동기화가 돌 때마다 up to date / syncing 이 1초마다 번갈아 바뀌어
              뭘 봐도 답이 나오지 않았다. 조용히 지낸 뒤의 결과만 말한다 — 실패와
              밀린 것은 끝까지 말한다.
            */}
            <dd className={shown === 'failed' ? 'text-status-unknown' : 'text-ink'}>
              {shown === 'failed'
                ? t('sync.failed')
                : shown === 'pending'
                  ? t('sync.pending')
                  : shown === 'syncing'
                    ? t('sync.syncing')
                    : t('account.status.synced')}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-ink-muted">{t('account.lastSynced')}</dt>
            <dd className="text-ink tabular-nums">
              {lastSyncedAt ? new Date(lastSyncedAt).toLocaleTimeString() : '—'}
            </dd>
          </div>
          {/* 여기선 무엇이 얼마나 밀렸는지 전부 말한다 — 일부러 확인하러 온 곳이다 */}
          {pending.dirty && (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-ink-muted">{t('account.pending')}</dt>
              <dd className="text-status-unsure tabular-nums">{pending.count}</dd>
            </div>
          )}
        </dl>

        <button
          type="button"
          disabled={status === 'syncing'}
          onClick={() => void syncNow()}
          className="border-line hover:border-accent mt-3 rounded-lg border px-3 py-1.5 text-sm disabled:opacity-40"
        >
          {t('account.syncNow')}
        </button>

        {syncError && <p className="text-status-unknown mt-2 text-xs">{syncError}</p>}
      </div>
    )
  }

  return (
    <div>
      <p className="text-sm font-medium">{t('account.title')}</p>
      <p className="text-ink-muted mt-1 text-xs">{t('account.hint')}</p>

      <div className="mt-3 flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value)
            if (authError) clearError()
          }}
          placeholder={t('account.emailPlaceholder')}
          aria-label={t('account.emailPlaceholder')}
          className="border-line focus:border-accent min-w-0 flex-1 rounded-lg border px-3 py-1.5 text-sm outline-none"
        />
        <button
          type="button"
          disabled={busy || email.trim() === ''}
          onClick={() => {
            setBusy(true)
            void sendMagicLink(email.trim()).finally(() => setBusy(false))
          }}
          className="rounded-lg border border-accent bg-accent px-3 py-1.5 text-sm text-accent-ink disabled:opacity-40"
        >
          {t('account.sendLink')}
        </button>
      </div>

      {/*
        Google provider 를 Supabase 콘솔에서 켜기 전에 배포하면 누가 눌렀을 때
        실패한다. 설정이 안 된 기능을 미리 보여주는 쪽이 나쁘므로 기본은 숨긴다.
      */}
      {showGoogleLogin() && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void signInWithGoogle().finally(() => setBusy(false))
          }}
          className="border-line hover:border-accent mt-2 w-full rounded-lg border px-3 py-1.5 text-sm disabled:opacity-40"
        >
          {t('account.google')}
        </button>
      )}

      {linkSent && <p className="text-status-unsure mt-3 text-xs">{t('account.linkSent')}</p>}
      {/* Supabase 원문을 그대로 붙잡지 않는다 — 무엇을 고쳐야 하는지까지 알려준다 */}
      {authError && (
        <div className="border-status-unknown mt-3 rounded-lg border p-2.5">
          <p className="text-status-unknown text-xs">
            {authErrorKeyOrMessage(authError)?.startsWith('account.error.')
              ? t(authErrorKeyOrMessage(authError) as never)
              : authError}
          </p>
        </div>
      )}
    </div>
  )
}
