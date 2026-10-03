import { useLanguagesStore } from '../../app/stores/languages'
import { useLanguageName, useTranslation } from '../../app/stores/settings'
import { SUPPORTED_LANGUAGES } from '../../lib/languages'
import { AppLanguageSwitcher } from '../settings/AppLanguageSwitcher'

/**
 * 배울 언어를 고르는 화면 (plan.txt 5줄).
 * 사전이 지원하는 전체 언어를 넣지 않고 화이트리스트만 노출한다.
 */
export function LanguagePicker({ onDone }: { onDone?: () => void }) {
  const t = useTranslation()
  const languageName = useLanguageName()
  const enrolled = useLanguagesStore((s) => s.enrolled)
  const toggle = useLanguagesStore((s) => s.toggle)

  return (
    <section className="mx-auto w-full max-w-2xl px-5 py-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">{t('onboarding.title')}</h1>
          <p className="text-ink-muted mt-1 text-sm">{t('onboarding.hint')}</p>
        </div>
        <AppLanguageSwitcher />
      </div>

      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {SUPPORTED_LANGUAGES.map((lang) => {
          const active = enrolled.includes(lang.code)
          return (
            <li key={lang.code}>
              <button
                type="button"
                onClick={() => toggle(lang.code)}
                aria-pressed={active}
                className={`flex w-full flex-col gap-0.5 rounded-xl border px-4 py-3 text-left transition ${
                  active
                    ? 'border-accent bg-accent text-accent-ink'
                    : 'border-line bg-surface hover:border-line'
                }`}
              >
                <span className="text-sm font-medium">{languageName(lang.code)}</span>
                <span className={`text-xs ${active ? 'text-ink-muted' : 'text-ink-muted'}`}>
                  {lang.nativeLabel}
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      {onDone && (
        <button
          type="button"
          onClick={onDone}
          disabled={enrolled.length === 0}
          className="mt-6 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink disabled:opacity-30"
        >
          {enrolled.length === 0 ? t('onboarding.selectAtLeastOne') : t('onboarding.done')}
        </button>
      )}
    </section>
  )
}