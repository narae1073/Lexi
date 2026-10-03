import { APP_LANGUAGES } from '../../i18n'
import { useSettingsStore } from '../../app/stores/settings'
import type { AppLanguage } from '../../i18n'

const SHORT: Record<AppLanguage, string> = { en: 'EN', ko: 'KO' }

/**
 * 앱 UI 언어 전환.
 * 언어를 늘릴 때 APP_LANGUAGES 에 항목만 추가하면 되고 사전(en.ts, ko.ts)만 더 만들면 된다.
 *
 * 온보딩 화면에도 노출한다 — 학습 언어를 고르기 전에 앱 언어를 바꾸고 싶은 경우가 있다.
 */
export function AppLanguageSwitcher({
  compact = false,
  className = '',
}: {
  /** 좁은 화면(내비게이션)에서는 두 글자 코드로 줄여 줄바꿈을 막는다 */
  compact?: boolean
  className?: string
}) {
  const appLanguage = useSettingsStore((s) => s.appLanguage)
  const setAppLanguage = useSettingsStore((s) => s.setAppLanguage)

  return (
    <div className={`flex items-center gap-1 ${className}`} role="group">
      {APP_LANGUAGES.map((lang) => {
        const active = appLanguage === lang.code
        return (
          <button
            key={lang.code}
            type="button"
            onClick={() => setAppLanguage(lang.code)}
            aria-pressed={active}
            className={`rounded px-1.5 py-0.5 text-xs transition ${
              active ? 'bg-accent text-accent-ink' : 'text-ink-muted hover:text-ink'
            }`}
          >
            {compact ? SHORT[lang.code] : lang.nativeLabel}
          </button>
        )
      })}
    </div>
  )
}