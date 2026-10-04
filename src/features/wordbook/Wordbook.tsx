import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { useDocumentsStore } from '../../app/stores/documents'
import { useLanguagesStore } from '../../app/stores/languages'
import { useOccurrencesStore } from '../../app/stores/occurrences'
import type { WordOccurrence } from '../../app/stores/occurrences'
import {
  useLanguageName,
  useSettingsStore,
  useTranslation,
} from '../../app/stores/settings'
import { useWordStatesStore } from '../../app/stores/wordStates'
import { paginate } from '../../lib/paginate'
import type { LanguageCode } from '../../types'
import { buildWordbook, groupByStatus, WORDBOOK_GROUPS } from './buildWordbook'
import type { WordbookGroup } from './buildWordbook'
import { PageSizeSelect } from './PageSizeSelect'
import { Pagination } from './Pagination'
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
  const [pageNumber, setPageNumber] = useState(1)

  const pageSize = useSettingsStore((s) => s.wordbookPageSize)
  const setPageSize = useSettingsStore((s) => s.setWordbookPageSize)

  const occurrences = useOccurrencesStore((s) => s.byLanguage[languageCode ?? ''] ?? EMPTY)
  const byKey = useWordStatesStore((s) => s.byKey)

  const entries = useMemo(
    () =>
      languageCode
        ? buildWordbook({ languageCode, occurrences, byKey, documentId, query })
        : [],
    [languageCode, occurrences, byKey, documentId, query],
  )
  const grouped = useMemo(() => groupByStatus(entries), [entries])

  /**
   * 언어나 상태 탭, 검색어, 쪽 수를 바꾸면 항상 첫 쪽으로 돌려보낸다.
   *
   * 목록이 줄어 마지막 쪽이 사라지는 경우까지 paginate 가 계산에서 당겨준다 —
   * 화면에 빈 쪽을 보여주지 않기 위해서다.
   */
  const resetPage = () => setPageNumber(1)
  const current = useMemo(
    () => paginate(grouped[group], pageNumber, pageSize),
    [grouped, group, pageNumber, pageSize],
  )

  if (!languageCode) {
    return (
      <section className="mx-auto w-full max-w-2xl px-5 py-8">
        <h1 className="text-lg font-semibold">{t('wordbook.title')}</h1>
        <p className="text-ink-muted mt-2 text-sm">{t('wordbook.pickLanguage')}</p>
      </section>
    )
  }

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
              onClick={() => {
                setLanguageCode(code)
                resetPage()
              }}
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
        onChange={(event) => {
          setQuery(event.target.value)
          resetPage()
        }}
        placeholder={t('wordbook.search')}
        className="border-line focus:border-accent mb-4 w-full rounded-lg border px-3 py-2 text-sm outline-none"
      />

      {/* 목록 위에 둔다 — 몇 개가 한 화면을 차지하는지 보고 고르는 게 자연스럽다 */}
      <PageSizeSelect
        value={pageSize}
        onChange={(size) => {
          setPageSize(size)
          resetPage()
        }}
      />

      {/* 상태별 구분 (plan.txt 9줄) */}
      <div className="border-line mb-1 flex overflow-x-auto border-b text-sm">
        {WORDBOOK_GROUPS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setGroup(key)
              resetPage()
            }}
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

      {current.items.length === 0 ? (
        <p className="text-ink-muted py-8 text-sm">{t(`wordbook.empty.${group}`)}</p>
      ) : (
        <ul className="divide-line divide-y">
          {current.items.map((entry) => (
            <WordbookItem key={entry.lemma} entry={entry} languageCode={languageCode} />
          ))}
        </ul>
      )}

      <Pagination page={current} onPageChange={setPageNumber} />
    </section>
  )
}
