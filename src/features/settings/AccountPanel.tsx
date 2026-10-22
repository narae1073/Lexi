import { useState } from 'react'

import { authErrorKeyOrMessage } from '../../lib/authError'
import { showGoogleLogin } from '../../lib/flags'
import { isSupabaseConfigured } from '../../lib/supabase/client'
import { resetLocalAccount } from '../../lib/storage/resetLocalAccount'
import { CODE_MAX_DIGITS, CODE_MIN_DIGITS, useAuthStore } from '../../app/stores/auth'
import { usePendingSummary, useSyncStore, useSyncStatus, waitForSyncIdle } from '../../app/stores/sync'
import { useTranslation } from '../../app/stores/settings'
import { ConfirmDialog } from '../reader/ConfirmDialog'

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
  const sendEmailCode = useAuthStore((s) => s.sendEmailCode)
  const verifyEmailCode = useAuthStore((s) => s.verifyEmailCode)
  const codeSent = useAuthStore((s) => s.codeSent)
  const code = useAuthStore((s) => s.code)
  const setCode = useAuthStore((s) => s.setCode)
  const signInWithGoogle = useAuthStore((s) => s.signInWithGoogle)
  const signOut = useAuthStore((s) => s.signOut)
  const clearError = useAuthStore((s) => s.clearError)

  const status = useSyncStore((s) => s.status)
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt)
  const syncError = useSyncStore((s) => s.error)
  const pending = usePendingSummary()
  const notice = useSyncStore((s) => s.notice)
  const shown = useSyncStatus(status, notice, pending.count)
  const report = useSyncStore((s) => s.report)
  const syncNow = useSyncStore((s) => s.syncNow)
  const fullResync = useSyncStore((s) => s.fullResync)
  const accountBlocked = useSyncStore((s) => s.accountBlocked)
  const claimNeeded = useSyncStore((s) => s.claimNeeded)
  const localOnly = useSyncStore((s) => s.localOnly)
  const claimLocalData = useSyncStore((s) => s.claimLocalData)
  const keepLocalOnly = useSyncStore((s) => s.keepLocalOnly)

  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)

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
    const reset = async () => {
      setConfirmReset(false)
      setResetting(true)
      setResetError(null)
      try {
        // 성공하면 새로고침된다 — 여기서 busy 를 풀면 잠깐 다시 눌린다
        await resetLocalAccount(user.id, { waitForIdle: waitForSyncIdle })
      } catch (cause) {
        // 지우지 못했으면 성공한 척하지 않는다 — 새로고침하지 않고 이유를 보여 준다
        setResetError(cause instanceof Error ? cause.message : String(cause))
        setResetting(false)
      }
    }

    const identity = (
      <>
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
      </>
    )

    const resetDialog = confirmReset ? (
      <ConfirmDialog
        title={t('account.resetLocal')}
        body={t('account.resetLocalConfirm')}
        confirmLabel={t('account.resetLocal')}
        onConfirm={() => void reset()}
        onClose={() => setConfirmReset(false)}
      />
    ) : null

    /**
     * App 전체 잠금이 먼저 막지만, 설정 화면이 직접 열리는 경로가 생겨도
     * 다른 계정의 데이터를 보여 주지 않도록 여기서도 막는다.
     */
    if (accountBlocked) {
      return (
        <div>
          {identity}
          <div className="mt-3">
            <p className="text-sm font-medium">{t('account.blockedTitle')}</p>
            <p className="text-ink-muted mt-1 text-xs">{t('account.blockedBody')}</p>
            <button
              type="button"
              disabled={resetting}
              onClick={() => {
                setResetError(null)
                setConfirmReset(true)
              }}
              className="border-status-unknown text-status-unknown hover:bg-status-unknown-bg mt-3 rounded-lg border px-3 py-1.5 text-sm disabled:opacity-40"
            >
              {t('account.resetLocal')}
            </button>
            {resetError && (
              <p className="text-status-unknown mt-2 text-xs break-words">{resetError}</p>
            )}
          </div>
          {resetDialog}
        </div>
      )
    }

    // 넘겨받을지 묻는 동안에는 동기화 상태를 말하지 않는다 — 아직 정해진 것이 없다
    if (claimNeeded) {
      return (
        <div>
          {identity}
          <p className="mt-3 text-sm font-medium">{t('account.claimPrompt')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => claimLocalData(user.id)}
              className="text-accent-ink rounded-lg border border-accent bg-accent px-3 py-1.5 text-sm"
            >
              {t('account.claimAction')}
            </button>
            <button
              type="button"
              onClick={() => keepLocalOnly()}
              className="border-line hover:border-accent rounded-lg border px-3 py-1.5 text-sm"
            >
              {t('account.keepLocalAction')}
            </button>
          </div>
          {resetDialog}
        </div>
      )
    }

    if (localOnly) {
      return (
        <div>
          {identity}
          <p className="mt-3 text-sm font-medium">{t('account.localOnlyTitle')}</p>
          <p className="text-ink-muted mt-1 text-xs">{t('account.localOnlyBody')}</p>
          <button
            type="button"
            onClick={() => claimLocalData(user.id)}
            className="border-line hover:border-accent mt-3 rounded-lg border px-3 py-1.5 text-sm"
          >
            {t('account.syncToAccount')}
          </button>
          {resetDialog}
        </div>
      )
    }

    return (
      <div>
        {identity}

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

        {/* The device clock moved back; push watermarks were cleared safely. */}
        {report?.warnings.includes('clock-rollback') && (
          <p className="text-status-unsure mt-2 text-xs">{t('account.clockRollback')}</p>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={status === 'syncing'}
            onClick={() => void syncNow()}
            className="border-line hover:border-accent rounded-lg border px-3 py-1.5 text-sm disabled:opacity-40"
          >
            {t('account.syncNow')}
          </button>
          {/*
            The way out when the device looks like it lost local data. It
            re-reads from the server and merges, so pressing it loses nothing.
          */}
          <button
            type="button"
            disabled={status === 'syncing'}
            onClick={() => void fullResync()}
            className="border-line hover:border-accent rounded-lg border px-3 py-1.5 text-sm disabled:opacity-40"
          >
            {t('account.refreshAll')}
          </button>
        </div>
        <p className="text-ink-muted mt-1 text-[10px]">{t('account.refreshAllHint')}</p>

        {/*
          마지막 동기화가 무엇을 했는지.

          기기마다 진도가 다를 때 '왜 이 기기만 최신이냐' 를 설명하려면, 이 기기가
          서버에 무엇을 보내고 무엇을 받았는지 **보여야** 한다. 없으면 추측만 된다.
        */}
        {/*
          숫자의 **단위**를 밝힌다.

          '진도 1000' 은 무엇을 센 것인지 알 수 없다 — 단어 수인지, 등장 횟수인지,
          저장 횟수인지. 서로 다른 문제로 이어지므로 모호하게 두지 않는다.
        */}
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-sm font-medium">{t('account.syncTitle')}</p>
          <p className="text-ink-muted mt-1 text-xs">{t('account.syncHint')}</p>

          <dl className="mt-2 space-y-1 text-xs">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-muted">{t('account.sent')}</dt>
              <dd className="text-ink tabular-nums">
                {report?.pushed ?? '—'}
                <span className="text-ink-muted ml-1 text-[10px]">{t('account.sentHint')}</span>
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-muted">{t('account.received')}</dt>
              <dd className="text-ink tabular-nums">
                {report?.pulled ?? '—'}
                <span className="text-ink-muted ml-1 text-[10px]">{t('account.receivedHint')}</span>
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-muted">{t('account.onServer')}</dt>
              <dd
                className={
                  (report?.serverWords ?? 0) === 0
                    ? 'text-status-unknown tabular-nums'
                    : 'text-ink tabular-nums'
                }
              >
                {report ? `${report.serverWords} / ${report.localWords}` : '—'}
                <span className="text-ink-muted ml-1 text-[10px]">{t('account.onServerHint')}</span>
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-muted">{t('account.documents')}</dt>
              <dd className="text-ink tabular-nums">
                {report?.documents ?? '—'}
                <span className="text-ink-muted ml-1 text-[10px]">{t('account.documentsHint')}</span>
              </dd>
            </div>
            {/* 저장 횟수 기준이다 — 단어 수가 아니므로 라벨이 다르다 */}
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-muted">{t('account.pending')}</dt>
              <dd className="text-ink tabular-nums">
                {pending.count}
                <span className="text-ink-muted ml-1 text-[10px]">{t('account.pendingHint')}</span>
              </dd>
            </div>
          </dl>

          {report !== null && report.pushed === 0 && report.pulled === 0 && (
            <p className="text-ink-muted mt-2 text-xs">{t('account.nothingSent')}</p>
          )}
        </div>

        {syncError && <p className="text-status-unknown mt-2 text-xs break-words">{syncError}</p>}

        {resetDialog}
      </div>
    )
  }

  return (
    <div>
      <p className="text-sm font-medium">{t('account.title')}</p>
      <p className="text-ink-muted mt-1 text-xs">{t('account.hint')}</p>

      {/*
        인증번호 방식이 주된 길이다. 링크를 열면 OS 가 기본 브라우저로 넘겨 버리고,
        이 앱은 브라우저마다 세션이 따로라 원래 쓰던 브라우저로 돌아오지 않는다.
        번호는 주소를 한 번도 열지 않으니 어디서 시작했든 그 브라우저에서 끝난다.
      */}
      {codeSent ? (
        <div className="mt-3">
          <p className="text-ink-muted mb-1.5 text-xs">{t('account.codeSent')}</p>
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(event) => {
                setCode(event.target.value.replace(/\D/g, '').slice(0, CODE_MAX_DIGITS))
                if (authError) clearError()
              }}
              // 붙여넣으면 곧바로 확인한다 — 자릿수를 모르므로 여기서 판단하지 않는다
              onPaste={() => {
                setTimeout(() => {
                  if (email.trim() !== '') {
                    setBusy(true)
                    void verifyEmailCode(email.trim()).finally(() => setBusy(false))
                  }
                }, 0)
              }}
              inputMode="numeric"
              maxLength={CODE_MAX_DIGITS}
              autoComplete="one-time-code"
              placeholder={t('account.codePlaceholder')}
              aria-label={t('account.codePlaceholder')}
              className="border-line focus:border-accent min-w-0 flex-1 rounded-lg border px-3 py-1.5 text-sm tracking-widest tabular-nums outline-none"
            />
            <button
              type="button"
              disabled={busy || code.replace(/\D/g, '').length < CODE_MIN_DIGITS}
              onClick={() => {
                setBusy(true)
                void verifyEmailCode(email.trim()).finally(() => setBusy(false))
              }}
              className="rounded-lg border border-accent bg-accent px-3 py-1.5 text-sm text-accent-ink disabled:opacity-40"
            >
              {t('account.codeVerify')}
            </button>
          </div>
          <button
            type="button"
            onClick={() => clearError()}
            className="text-ink-muted hover:text-ink mt-2 text-[10px] underline"
          >
            {t('account.useLinkInstead')}
          </button>
        </div>
      ) : (
        <>
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
            void sendEmailCode(email.trim()).finally(() => setBusy(false))
          }}
          className="shrink-0 rounded-lg border border-accent bg-accent px-3 py-1.5 text-sm text-accent-ink disabled:opacity-40"
        >
          {t('account.sendCode')}
        </button>
      </div>

      {/* 링크가 필요한 경우를 위한 보조 길 — 기본 브라우저에서 열면 그 브라우저에만
          로그인되므로 그대로 두고 이유를 밝힌다 */}
      <button
        type="button"
        disabled={busy || email.trim() === ''}
        onClick={() => {
          setBusy(true)
          void sendMagicLink(email.trim()).finally(() => setBusy(false))
        }}
        className="text-ink-muted hover:text-ink mt-2 text-[10px] underline disabled:opacity-40"
      >
        {t('account.sendLinkInstead')}
      </button>
      <p className="text-ink-muted mt-1 text-[10px]">{t('account.linkWarning')}</p>
        </>
      )}

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
