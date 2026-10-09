import { useSettingsStore, useTranslation } from '../../app/stores/settings'
import { AccountPanel } from './AccountPanel'
import { AppLanguageSwitcher } from './AppLanguageSwitcher'
import { FavoriteStarControl } from './FavoriteStarControl'
import { ThemePicker } from './ThemePicker'
import { TextScaleControl } from './TextScaleControl'
import { UnmarkedDimControl } from './UnmarkedDimControl'

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