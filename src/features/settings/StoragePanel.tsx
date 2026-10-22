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
 * Storage card.
 *
 * Shows whether the browser may clear local data and how much the app uses. Not
 * every browser exposes the same Storage API, so an unknown state is reported
 * as unknown — claiming "persisted" on an unsupported browser would tell the
 * user their data is safer than it is.
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
