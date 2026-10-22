import { useEffect, useState } from 'react'

import { useTranslation } from '../../app/stores/settings'
import {
  getStorageEstimate,
  isStoragePersisted,
  isStorageSupported,
  requestPersistentStorage,
} from '../../lib/storage/storagePersistence'

type Estimate = { usage: number; quota: number }

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes === 0) return '0 KB'
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.max(1, Math.round(kb))} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

/**
 * 저장 공간 카드.
 *
 * 브라우저가 로컬 데이터를 지울 수 있는지와 얼마나 쓰고 있는지 보여 준다. 모든
 * 브라우저가 같은 API 를 제공하지 않으므로, 모르면 **모른다고** 말한다 — 지원하지
 * 않는 환경에서 '보관됨' 이라고 단정하면 사용자가 데이터가 안전하다고 오해한다.
 */
export function StoragePanel() {
  const t = useTranslation()
  // Supported + persisted settle together so the first paint never claims
  // either state before the browser has answered.
  const [status, setStatus] = useState<{ supported: boolean; persisted: boolean } | null>(null)
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const supported = isStorageSupported()
      const [persisted, usage] = await Promise.all([
        isStoragePersisted(),
        getStorageEstimate(),
      ])
      if (cancelled) return
      setStatus({ supported, persisted })
      setEstimate(usage)
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const request = async () => {
    setBusy(true)
    try {
      // A denial is a valid outcome — re-read the real state instead of
      // assuming the request succeeded.
      await requestPersistentStorage()
      const persisted = await isStoragePersisted()
      setStatus((current) => (current ? { ...current, persisted } : current))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <p className="text-sm font-medium">{t('settings.storageTitle')}</p>

      {status?.supported === false ? (
        <p className="text-ink-muted mt-1 text-xs">{t('settings.storageUnavailable')}</p>
      ) : status?.supported === true ? (
        <>
          <p className="text-ink-muted mt-1 text-xs">
            {status.persisted
              ? t('settings.storagePersisted')
              : t('settings.storageNotPersisted')}
          </p>

          {estimate !== null && (
            <p className="text-ink-muted mt-1 text-xs tabular-nums">
              {t('settings.storageUsage', {
                used: formatBytes(estimate.usage),
                quota: formatBytes(estimate.quota),
              })}
            </p>
          )}

          {!status.persisted && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void request()}
              className="border-line hover:border-accent mt-2 rounded-lg border px-3 py-1.5 text-sm disabled:opacity-40"
            >
              {t('settings.storageRequest')}
            </button>
          )}
        </>
      ) : null}
    </div>
  )
}
