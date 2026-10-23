import { useEffect, useState } from 'react'

import { useTranslation } from '../../app/stores/settings'
import { CACHE_MAX_BYTES } from '../../lib/api/offlineCache'
import {
  getStorageEstimate,
  isStoragePersisted,
  isStorageSupported,
  requestPersistentStorage,
} from '../../lib/storage/storagePersistence'
import { downloadChineseDictionary } from '../reader/chinese'
import { downloadJapaneseDictionary } from '../reader/japanese'
import {
  DICTIONARY_DOWNLOADS,
  downloadedDictionaries,
  type LinderaDict,
} from '../reader/lindera'

type Estimate = { usage: number; quota: number }
type DictionaryState = Record<LinderaDict, boolean>

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes === 0) return '0 KB'
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.max(1, Math.round(kb))} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

const DICT_ORDER: LinderaDict[] = ['ja', 'zh']

/**
 * Storage card.
 *
 * Shows whether the browser may clear local data and how much the app uses. Not
 * every browser exposes the same Storage API, so an unknown state is reported
 * as unknown — claiming "persisted" on an unsupported browser would tell the
 * user their data is safer than it is.
 *
 * Dictionary downloads live here because they are the two big, visible things
 * this app stores besides learning data: the user can see the exact size before
 * fetching a zip, and can fetch one on demand even after declining the prompt.
 */
export function StoragePanel() {
  const t = useTranslation()
  // Supported + persisted settle together so the first paint never claims
  // either state before the browser has answered.
  const [status, setStatus] = useState<{ supported: boolean; persisted: boolean } | null>(null)
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [busy, setBusy] = useState(false)
  const [dictionaries, setDictionaries] = useState<DictionaryState | null>(null)
  const [downloading, setDownloading] = useState<LinderaDict | null>(null)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const supported = isStorageSupported()
      const [persisted, usage, downloaded] = await Promise.all([
        isStoragePersisted(),
        getStorageEstimate(),
        downloadedDictionaries(),
      ])
      if (cancelled) return
      setStatus({ supported, persisted })
      setEstimate(usage)
      setDictionaries({
        ja: downloaded.includes('ja'),
        zh: downloaded.includes('zh'),
      })
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

  const download = async (dict: LinderaDict) => {
    setDownloading(dict)
    try {
      // The language module asks for confirmation with the exact zip size.
      if (dict === 'ja') await downloadJapaneseDictionary()
      else await downloadChineseDictionary()

      const downloaded = await downloadedDictionaries()
      setDictionaries({
        ja: downloaded.includes('ja'),
        zh: downloaded.includes('zh'),
      })
    } finally {
      setDownloading(null)
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

      <p className="text-ink-muted mt-2 text-xs">
        {t('settings.storageResponseCache', { size: formatBytes(CACHE_MAX_BYTES) })}
      </p>

      <p className="mt-3 text-sm font-medium">{t('settings.dictionaryTitle')}</p>
      <div className="mt-1 space-y-1">
        {DICT_ORDER.map((dict) => (
          <div key={dict} className="flex items-center justify-between gap-3 text-xs">
            <span className="text-ink-muted">
              {t(dict === 'ja' ? 'languageNames.ja' : 'languageNames.zh')} ·{' '}
              {DICTIONARY_DOWNLOADS[dict].label}
            </span>

            {dictionaries?.[dict] ? (
              <span className="text-ink-muted">{t('settings.dictionaryDownloaded')}</span>
            ) : (
              <button
                type="button"
                disabled={downloading !== null}
                onClick={() => void download(dict)}
                className="border-line hover:border-accent rounded-lg border px-2 py-1 disabled:opacity-40"
              >
                {downloading === dict
                  ? t('list.loading')
                  : t('settings.dictionaryDownload', {
                      size: DICTIONARY_DOWNLOADS[dict].label,
                    })}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
