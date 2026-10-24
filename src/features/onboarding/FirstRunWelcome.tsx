import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { useLanguageName, useTranslation } from '../../app/stores/settings'
import { getLanguageFlag } from '../../lib/languages'
import type { Document } from '../../types'
import {
  dismissFirstRunWelcome,
  readFirstRunRecord,
  resolveFirstRunStories,
  type FirstRunRecord,
} from './firstRun'

/**
 * First-run welcome card shown above the library.
 *
 * It is deliberately local-only: the marker and the starter documents are
 * created on this device. A device that adopts an existing account never has
 * this marker, so it does not show a welcome for content another device created.
 */
export function FirstRunWelcome({ documents }: { documents: readonly Document[] }) {
  const t = useTranslation()
  const languageName = useLanguageName()
  const [record, setRecord] = useState<FirstRunRecord | null | undefined>(undefined)

  useEffect(() => {
    let alive = true
    void readFirstRunRecord()
      .then((next) => {
        if (alive) setRecord(next ?? null)
      })
      .catch(() => {
        if (alive) setRecord(null)
      })
    return () => {
      alive = false
    }
  }, [])

  if (record === undefined || record === null || record.dismissedAt) return null

  const stories = resolveFirstRunStories(record, documents)
  if (stories.length === 0) return null

  const dismiss = () => {
    setRecord({ ...record, dismissedAt: new Date().toISOString() })
    void dismissFirstRunWelcome().catch((error) => {
      console.error('첫 실행 환영 닫기 실패', error)
    })
  }

  return (
    <section
      data-first-run-welcome
      aria-labelledby="first-run-welcome-title"
      className="border-line bg-surface mx-5 mt-4 rounded-xl border p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {stories.map((row) => (
              <span
                key={row.languageCode}
                className="border-line bg-bg text-ink inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
              >
                <span aria-hidden>{getLanguageFlag(row.languageCode)}</span>
                {row.story.greeting}
              </span>
            ))}
          </div>
          <h2 id="first-run-welcome-title" className="text-sm font-semibold">
            {t('onboarding.welcomeTitle')}
          </h2>
        </div>
        <button
          type="button"
          data-first-run-welcome-close
          onClick={dismiss}
          aria-label={t('onboarding.welcomeClose')}
          className="text-ink-muted hover:text-ink hover:bg-surface-hover focus-visible:outline-accent -mt-1 shrink-0 rounded-lg p-2 text-base leading-none focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          ×
        </button>
      </div>

      <p className="text-ink-muted mt-1 text-xs leading-relaxed">
        {t('onboarding.welcomeBody')}
      </p>

      <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
        {stories.map((row) => (
          <li key={row.languageCode} data-first-run-story={row.languageCode}>
            <Link
              to={`/read/${row.document.id}`}
              className="border-line bg-bg hover:border-accent focus-visible:outline-accent flex min-h-14 items-center gap-2.5 rounded-lg border px-2.5 py-2 transition focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <span aria-hidden className="shrink-0 text-lg">
                {getLanguageFlag(row.languageCode)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold">{row.document.title}</span>
                <span className="text-ink-muted mt-0.5 block truncate text-[11px]">
                  {row.story.snippet}
                </span>
                <span className="text-ink-muted mt-0.5 block text-[10px]">
                  {languageName(row.languageCode)}
                </span>
              </span>
              <span className="text-accent shrink-0 text-[11px] font-medium">
                {t('onboarding.welcomeRead')}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-ink-muted text-[11px]">{t('onboarding.welcomeDeleteNote')}</span>
        <button
          type="button"
          data-first-run-welcome-dismiss
          onClick={dismiss}
          className="border-line text-ink hover:border-accent focus-visible:outline-accent min-h-9 rounded-lg border px-3 text-xs font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {t('onboarding.welcomeDismiss')}
        </button>
      </div>
    </section>
  )
}
