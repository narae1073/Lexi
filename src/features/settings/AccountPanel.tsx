import { useState } from 'react'

import { isSupabaseConfigured } from '../../lib/supabase/client'
import { useAuthStore } from '../../app/stores/auth'
import { useSyncStore } from '../../app/stores/sync'
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
            <dd className={status === 'error' ? 'text-status-unknown' : 'text-ink'}>
              {t(`account.status.${status}`)}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-ink-muted">{t('account.lastSynced')}</dt>
            <dd className="text-ink tabular-nums">
              {lastSyncedAt ? new Date(lastSyncedAt).toLocaleTimeString() : '—'}
            </dd>
          </div>
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

      {linkSent && <p className="text-status-unsure mt-3 text-xs">{t('account.linkSent')}</p>}
      {authError && <p className="text-status-unknown mt-3 text-xs">{authError}</p>}
    </div>
  )
}
