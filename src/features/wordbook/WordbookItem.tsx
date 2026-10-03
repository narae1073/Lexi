import { useState } from 'react'

import { useTranslation } from '../../app/stores/settings'
import { useWordStatesStore } from '../../app/stores/wordStates'
import { WORD_STATUSES, type LanguageCode, type WordStatus } from '../../types'
import type { WordbookEntry } from './buildWordbook'

/**
 * 단어 한 개.
 * 표기(또는 여러 표기) · 예문 · 출처 문서 · 상태 변경을 보여준다.
 */
export function WordbookItem({
  entry,
  languageCode,
}: {
  entry: WordbookEntry
  languageCode: LanguageCode
}) {
  const t = useTranslation()
  const setStatus = useWordStatesStore((s) => s.setStatus)
  const [expanded, setExpanded] = useState(false)

  return (
    <li className="py-3">
      <div className="flex items-baseline justify-between gap-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
        >
          <span className="truncate text-sm font-medium">{entry.lemma}</span>
          {entry.surfaces.length > 1 && (
            <span className="text-ink-muted shrink-0 text-[11px]">
              {entry.surfaces.filter((s) => s !== entry.lemma).join(' / ')}
            </span>
          )}
          <span className="text-ink-muted ml-auto shrink-0 text-[11px]">×{entry.count}</span>
        </button>
      </div>

      <p className="text-ink-muted mt-0.5 line-clamp-2 text-xs leading-relaxed">
        {expanded && entry.sentence ? entry.sentence : entry.sentence || t('wordbook.noContext')}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="group" aria-label={t('status.group')}>
          {WORD_STATUSES.map((status: WordStatus) => {
            const active = entry.status === status
            return (
              <button
                key={status}
                type="button"
                onClick={() => setStatus(languageCode, entry.lemma, status, entry.lemma)}
                aria-pressed={active}
                aria-label={t(`status.${status}`)}
                title={t(`status.${status}`)}
                className={`rounded border px-2 py-0.5 text-[11px] transition ${
                  active
                    ? 'border-accent bg-accent text-accent-ink'
                    : 'text-ink-muted border-line hover:border-accent'
                }`}
              >
                {t(`status.short${CAP[status]}`)}
              </button>
            )
          })}
        </div>

        <span className="text-ink-muted truncate text-[11px]">
          {entry.documentTitle}
          {entry.documentCount > 1 && ` +${entry.documentCount - 1}`}
        </span>
      </div>
    </li>
  )
}

const CAP = { known: 'Known', unsure: 'Unsure', unknown: 'Unknown' } as const