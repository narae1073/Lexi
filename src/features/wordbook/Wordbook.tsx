import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { useDocumentsStore } from '../../app/stores/documents'
import { useLanguagesStore } from '../../app/stores/languages'
import { useOccurrencesStore } from '../../app/stores/occurrences'
import type { WordOccurrence } from '../../app/stores/occurrences'
import { useLanguageName, useTranslation } from '../../app/stores/settings'
import { useWordStatesStore } from '../../app/stores/wordStates'
import type { LanguageCode } from '../../types'
import { buildWordbook, groupByStatus, WORDBOOK_GROUPS } from './buildWordbook'
import type { WordbookGroup } from './buildWordbook'
import { WordbookItem } from './WordbookItem'

type GroupKey = WordbookGroup

const EMPTY: WordOccurrence[] = []

/**
 * 단어장 (plan.txt 9줄).
 * 메인 화면에서도, 문서 안에서도 들어올 수 있고 언어를 먼저 고른다.
 */
export function Wordbook() {
  const t = useTranslation()
  const languageName = useLanguageName()
  const [params] = useSearchParams()
  const enrolled = useLanguagesStore((s) => s.enrolled)

  const documentId = params.get('doc') ?? undefined
  const documents = useDocumentsStore((s) => s.documents)
  const scopedDocument = documentId ? documents.find((d) => d.id === documentId) : undefined

  const requested = params.get('lang')
  const initial: LanguageCode | null = enrolled.includes(requested as LanguageCode)
    ? (requested as LanguageCode)
    : (enrolled[0] ?? null)

  const [languageCode, setLanguageCode] = useState<LanguageCode | null>(initial)
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState<GroupKey>('unmarked')

  const occurrences = useOccurrencesStore((s) => s.byLanguage[languageCode ?? ''] ?? EMPTY)
  const loadOccurrences = useOccurrencesStore((s) => s.loadLanguage)
  const byKey = useWordStatesStore((s) => s.byKey)

  const entries = useMemo(
    () =>
      languageCode
        ? buildWordbook({ languageCode, occurrences, byKey, documentId, query })
        : [],
    [languageCode, occurrences, byKey, documentId, query],
  )
  const grouped = useMemo(() => groupByStatus(entries), [entries])

  if (!languageCode) {
    return (
      <section className="mx-auto w-full max-w-2xl px-5 py-8">
        <h1 className="text-lg font-semibold">{t('wordbook.title')}</h1>
        <p className="text-ink-muted mt-2 text-sm">{t('wordbook.pickLanguage')}</p>
      </section>
    )
  }

  const list = grouped[group]

  return (
    <section className="mx-auto w-full max-w-2xl px-5 py-8">
      <header className="mb-5">
        <h1 className="text-lg font-semibold">{t('wordbook.title')}</h1>
        <p className="text-ink-muted mt-1 text-xs">
          {scopedDocument
            ? t('wordbook.scoped', { title: scopedDocument.title })
            : t('wordbook.summary', { count: entries.length })}
        </p>
      </header>

      {enrolled.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {enrolled.map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => setLanguageCode(code)}
              aria-pressed={code === languageCode}
              className={
                code === languageCode
                  ? 'rounded-lg border border-accent bg-accent px-3 py-1.5 text-sm text-accent-ink'
                  : 'rounded-lg border border-line px-3 py-1.5 text-sm hover:border-accent'
              }
            >
              {languageName(code)}
            </button>
          ))}
        </div>
      )}

      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('wordbook.search')}
        className="border-line focus:border-accent mb-4 w-full rounded-lg border px-3 py-2 text-sm outline-none"
      />

      {/* 상태별 구분 (plan.txt 9줄) */}
      <div className="border-line mb-1 flex overflow-x-auto border-b text-sm">
        {WORDBOOK_GROUPS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setGroup(key)}
            aria-pressed={key === group}
            className={
              key === group
                ? 'text-ink -mb-px shrink-0 border-b-2 border-accent px-3 py-2 font-medium'
                : 'text-ink-muted hover:text-ink -mb-px shrink-0 border-b-2 border-transparent px-3 py-2'
            }
          >
            {t(`wordbook.group.${key}`)}
            <span className="text-ink-muted ml-1.5 text-xs">{grouped[key].length}</span>
          </button>
        ))}
      </div>

      <p className="text-ink-muted mb-3 text-xs">{t('wordbook.legend')}</p>

      {list.length === 0 ? (
        <p className="text-ink-muted py-8 text-sm">{t(`wordbook.empty.${group}`)}</p>
      ) : (
        <ul className="divide-line divide-y">
          {list.map((entry) => (
            <WordbookItem key={entry.lemma} entry={entry} languageCode={languageCode} />
          ))}
        </ul>
      )}

      <PendingLanguageLoad languageCode={languageCode} onLoad={loadOccurrences} />
    </section>
  )
}

/**
 * store 에는 현재 언어의 기록만 들어 있다.
 * 언어를 바꿨다가 돌아왔을 때 아직 안 읽은 상태일 수 있다.
 */
function PendingLanguageLoad({
  languageCode,
  onLoad,
}: {
  languageCode: LanguageCode
  onLoad: (languageCode: LanguageCode) => Promise<void>
}) {
  const loaded = useOccurrencesStore((s) => s.byLanguage[languageCode])
  const [requestedFor, setRequestedFor] = useState<LanguageCode | null>(null)

  if (loaded === undefined && requestedFor !== languageCode) {
    setRequestedFor(languageCode)
    void onLoad(languageCode)
  }

  return null
}