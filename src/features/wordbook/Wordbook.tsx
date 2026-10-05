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
import { DocumentScopeSelect } from './DocumentScopeSelect'
import { WordStatusChart } from './WordStatusChart'
import { countsFromGroups } from './statusChart'
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
  const [params, setSearchParams] = useSearchParams()
  const enrolled = useLanguagesStore((s) => s.enrolled)

  const documentId = params.get('doc') ?? undefined
  const allDocuments = useDocumentsStore((s) => s.documents)

  const requested = params.get('lang')
  const initial: LanguageCode | null = enrolled.includes(requested as LanguageCode)
    ? (requested as LanguageCode)
    : (enrolled[0] ?? null)

  const [languageCode, setLanguageCode] = useState<LanguageCode | null>(initial)

  /**
   * 이 언어의 문서만 고른다 — 다른 언어 문서를 고르면 빈 목록만 나온다.
   *
   * 단어장은 언어를 바꿀 때 선택을 함께 버린다. German 문서로 좁힌 채 언어를 바꾸면
   * 아무 말도 없는 화면이 되는데, 그건 범위가 잘못된 것이지 데이터가 없는 것이 아니다.
   */
  const documents = useMemo(
    () => allDocuments.filter((d) => !d.deletedAt && d.languageCode === languageCode),
    [allDocuments, languageCode],
  )
  // 버려진 문서를 가리키는 링크면 범위가 없는 것으로 본다 — 기록은 남지만 대상은 없다
  const scopedDocument = documentId
    ? documents.find((d) => d.id === documentId)
    : undefined
  // 문서가 없거나 다른 언어의 문서면 범위를 푼다 — 빈 화면 대신 전체를 보여 준다
  const effectiveDocumentId = scopedDocument?.id

  const [query, setQuery] = useState('')
  const [group, setGroup] = useState<GroupKey>('unmarked')
  const [pageNumber, setPageNumber] = useState(1)

  const pageSize = useSettingsStore((s) => s.wordbookPageSize)
  const setPageSize = useSettingsStore((s) => s.setWordbookPageSize)

  const occurrences = useOccurrencesStore((s) => s.byLanguage[languageCode ?? ''] ?? EMPTY)
  const byKey = useWordStatesStore((s) => s.byKey)

  const entries = useMemo(() => {
    if (!languageCode) return []
    // 범위는 목록 안에서 다시 확인한다 — deps 에 파생값을 넣지 않으려면 어쩔 수 없다
    const scoped = documents.find((d) => d.id === documentId)?.id
    return buildWordbook({ languageCode, occurrences, byKey, documentId: scoped, query })
  }, [languageCode, occurrences, byKey, documents, documentId, query])
  const grouped = useMemo(() => groupByStatus(entries), [entries])

  /**
   * 언어나 상태 탭, 검색어, 쪽 수를 바꾸면 항상 첫 쪽으로 돌려보낸다.
   *
   * 목록이 줄어 마지막 쪽이 사라지는 경우까지 paginate 가 계산에서 당겨준다 —
   * 화면에 빈 쪽을 보여주지 않기 위해서다.
   */
  const resetPage = () => setPageNumber(1)

  /**
   * 범위를 푼다 — 언어 버튼에서 언어를 바꿀 때 부른다.
   *
   * 바꾸려는 언어를 넘겨 받는다. 상태를 그대로 쓰면 아직 갱신되기 전의 이전 언어가
   * 주소에 들어간다 — '영어' 를 눌렀는데 주소는 한국어, 새로고침하면 한국어 단어장이
   * 열린다. 아무 말도 없는 화면을 마주한 사람은 무엇이 잘못됐는지 알 길이 없다.
   */
  const clearScope = (next: LanguageCode) => {
    setSearchParams({ lang: next }, { replace: true })
  }

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

      {/*
        지금 보고 있는 범위의 통계를 먼저 보여 준다. 목록 아래에 두면 아래까지 스크롤한
        뒤에야 '얼마나 남았지' 를 알게 되는데, 그 판단이 먼저여야 고르기 시작할 수 있다.
        범위가 좁혀져 있으면 그 범위의 통계가 된다 — 같은 화면에서 다른 말을 하지 않는다.
      */}
      <div className="mb-4">
        <WordStatusChart counts={countsFromGroups(grouped)} />
      </div>

      {enrolled.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {enrolled.map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => {
                setLanguageCode(code)
                resetPage()
                // 다른 언어 문서로 좁힌 채 이동하면 빈 목록만 보인다
                clearScope(code)
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

      <DocumentScopeSelect
        value={effectiveDocumentId ?? ''}
        documents={documents}
        onChange={(id) => {
          resetPage()
          if (id) setSearchParams({ lang: languageCode, doc: id }, { replace: true })
          else setSearchParams({ lang: languageCode }, { replace: true })
        }}
      />

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
