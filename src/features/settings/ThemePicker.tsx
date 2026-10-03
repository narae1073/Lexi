import { useSettingsStore, useTranslation } from '../../app/stores/settings'
import { DEFAULT_THEME, isThemeId, THEMES, type ThemeId } from './themes'

/** 현재 적용 중인 테마 (명시 선택이 없으면 시스템 설정을 따른다) */
function useCurrentTheme(): ThemeId {
  const theme = useSettingsStore((s) => s.theme)
  const resolved = useSettingsStore((s) => s.resolvedTheme)
  const id = theme ?? resolved()
  return isThemeId(id) ? id : DEFAULT_THEME
}

/**
 * 테마 선택.
 * 색 줄 세 개로 미리 보여주어 사용자가 색을 보고 고르게 한다.
 */
export function ThemePicker() {
  const t = useTranslation()
  const current = useCurrentTheme()
  const setTheme = useSettingsStore((s) => s.setTheme)

  return (
    <div>
      <p className="text-sm font-medium">{t('settings.theme')}</p>
      <ul className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {THEMES.map((item) => {
          const active = current === item.id
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => setTheme(item.id)}
                aria-pressed={active}
                className={`flex w-full flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-left transition ${
                  active ? 'border-accent ring-accent/30 ring-2' : 'border-line hover:border-accent'
                }`}
              >
                <span
                  aria-hidden
                  className="flex h-8 flex-col justify-center gap-1 rounded-md p-1.5"
                  style={{ backgroundColor: item.swatch.bg }}
                >
                  <span className="block h-1 w-3/4 rounded-full" style={{ backgroundColor: item.swatch.bar }} />
                  <span className="block h-1 w-1/2 rounded-full" style={{ backgroundColor: item.swatch.dot }} />
                </span>
                <span className="text-xs font-medium">{item.label}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}