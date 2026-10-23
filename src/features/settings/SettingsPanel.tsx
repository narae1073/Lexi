import { useState } from 'react'

import { useSettingsStore, useTranslation } from '../../app/stores/settings'
import {
  DICTIONARY_DOWNLOADS,
  isDictionaryAutoDownloadEnabled,
  setDictionaryAutoDownloadEnabled,
} from '../reader/lindera'
import { AccountPanel } from './AccountPanel'
import { AppLanguageSwitcher } from './AppLanguageSwitcher'
import { FavoriteStarControl } from './FavoriteStarControl'
import { StoragePanel } from './StoragePanel'
import { ThemePicker } from './ThemePicker'
import { TextScaleControl } from './TextScaleControl'
import { UnmarkedDimControl } from './UnmarkedDimControl'

/**
 * 사전 다운로드 설정.
 *
 * 사전 zip 은 10.5 MB / 7.25 MB 라서 기본은 '묻기'다. 자동을 켜도 데이터
 * 절약 모드나 느린 연결에서는 앱이 다시 확인한다 (lindera.ts 의 정책).
 */
function DictionaryDownloads() {
  const t = useTranslation()
  const [autoDownload, setAutoDownload] = useState(isDictionaryAutoDownloadEnabled)

  return (
    <div>
      <p className="text-sm font-medium">{t('settings.dictionaryTitle')}</p>
      <p className="text-ink-muted mt-1 text-xs">
        {t('settings.dictionaryHint', {
          jaSize: DICTIONARY_DOWNLOADS.ja.label,
          zhSize: DICTIONARY_DOWNLOADS.zh.label,
        })}
      </p>

      <label className="mt-2 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={autoDownload}
          onChange={(event) => {
            setDictionaryAutoDownloadEnabled(event.target.checked)
            setAutoDownload(event.target.checked)
          }}
          className="accent-accent h-4 w-4"
        />
        {t('settings.dictionaryAutoDownload')}
      </label>

      <p className="text-ink-muted mt-1 text-xs">
        {t('settings.dictionaryAutoDownloadHint')}
      </p>
    </div>
  )
}

export function SettingsPanel() {
  const t = useTranslation()
  const theme = useSettingsStore((s) => s.theme)
  const setTheme = useSettingsStore((s) => s.setTheme)

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-5 py-8">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">{t('settings.title')}</h1>
        <a href="/" className="text-ink-muted text-sm hover:text-ink">
          {t('settings.close')}
        </a>
      </header>

      <div>
        <p className="text-sm font-medium">{t('settings.appLanguage')}</p>
        <div className="mt-2">
          <AppLanguageSwitcher />
        </div>
      </div>

      <AccountPanel />

      <DictionaryDownloads />

      <StoragePanel />

      <TextScaleControl />

      <UnmarkedDimControl />

      <FavoriteStarControl />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setTheme(null)}
          aria-pressed={theme === null}
          className={`rounded-lg border px-3 py-1.5 text-sm transition ${
            theme === null ? 'border-accent bg-accent text-accent-ink' : 'border-line hover:border-accent'
          }`}
        >
          {t('settings.system')}
        </button>
      </div>

      <ThemePicker />
    </section>
  )
}