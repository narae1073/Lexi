import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { useDocumentsStore } from '../../app/stores/documents'
import { useAuthStore } from '../../app/stores/auth'
import { useLanguagesStore } from '../../app/stores/languages'
import { useOccurrencesStore } from '../../app/stores/occurrences'
import type { WordOccurrence } from '../../app/stores/occurrences'
import {
  useLanguageName,
  useSettingsStore,
  useTranslation,
} from '../../app/stores/settings'
import { useSyncStore } from '../../app/stores/sync'
import { useWordbookStore } from '../../app/stores/wordbook'
import { useWordStatesStore } from '../../app/stores/wordStates'
import { paginate } from '../../lib/paginate'
import type { LanguageCode } from '../../types'
import { buildWordbook, filterByStarColors, groupByStatus, WORDBOOK_GROUPS } from './buildWordbook'
import type { WordbookEntry } from './buildWordbook'
import type { ProjectionWordbookEntry } from './wordbookProjection'
import {
  preparationProgress,
  resolveWordbookPresentation,
  resolveWordbookRowSource,
  scopeProjectionEntry,
  searchProjectionEntries,
} from './wordbookProjection'
import { searchLocalProjection } from './localProjection'
import { createWordbookWorkerClient } from './wordbookWorker'
import { DocumentScopeSelect } from './DocumentScopeSelect'
import { StarColorFilter } from './StarColorFilter'
import { WordStatusChart } from './WordStatusChart'
import { countsFromGroups } from './statusChart'
import { PageSizeSelect } from './PageSizeSelect'
import { Pagination } from './Pagination'
import { WordbookItem } from './WordbookItem'

const EMPTY: WordOccurrence[] = []
const EMPTY_ENTRIES: ProjectionWordbookEntry[] = []
const EMPTY_PAUSED: string[] = []

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
  /**
   * 마지막으로 본 탭을 기억한다 — 새로고침해도 그 탭에 머문다.
   * 처음 여는 자리는 ★(설정 기본값)다.
   */
  const group = useSettingsStore((s) => s.wordbookGroup)
  const setGroup = useSettingsStore((s) => s.setWordbookGroup)
  const [pageNumber, setPageNumber] = useState(1)

  const pageSize = useSettingsStore((s) => s.wordbookPageSize)
  const setPageSize = useSettingsStore((s) => s.setWordbookPageSize)

  const occurrences = useOccurrencesStore((s) => s.byLanguage[languageCode ?? ''] ?? EMPTY)
  const byKey = useWordStatesStore((s) => s.byKey)
  const localOnly = useSyncStore((s) => s.localOnly)
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt)
  const pausedLanguages = useSyncStore((s) => s.report?.projectionPaused ?? EMPTY_PAUSED)
  const pausedReason = useSyncStore((s) => s.report?.projectionPausedReason ?? null)
  const quotaRetrySeconds = useSyncStore(
    (s) => s.report?.projectionQuotaRetryAfterSeconds ?? null,
  )
  const syncNow = useSyncStore((s) => s.syncNow)
  const userId = useAuthStore((s) => s.user?.id ?? null)
  const projectionEntries = useWordbookStore(
    (s) => s.entriesByLanguage[languageCode ?? ''] ?? EMPTY_ENTRIES,
  )
  const projectionRevision = useWordbookStore((s) => s.dataRevision)
  const projectionComplete = useWordbookStore(
    (s) => s.projectionCompleteByLanguage[languageCode ?? ''] === true,
  )
  const projectionLoaded = useWordbookStore(
    (s) => s.loadedLanguages[languageCode ?? ''] === true,
  )
  const completeByLanguage = useWordbookStore((s) => s.projectionCompleteByLanguage)
  const refreshFromStore = useWordbookStore((s) => s.refreshFromStore)
  const refreshReadiness = useWordbookStore((s) => s.refreshProjectionReadiness)

  const projectionReady = localOnly ? projectionLoaded : projectionComplete && projectionLoaded
  const presentation = resolveWordbookPresentation({
    localOnly,
    projectionReady,
    projectionPaused: languageCode !== null && pausedLanguages.includes(languageCode),
    // The R2 device already has an occurrence-built wordbook. A new device has
    // none, so it gets the preparing state instead of an empty list.
    hasLocalWordbook: occurrences.length > 0,
  })
  const localSource = presentation.source === 'local'
  const preparation = preparationProgress(completeByLanguage, enrolled)
  const quotaPaused = presentation.showPaused && pausedReason === 'quota'
  const statePaused = presentation.showPaused && pausedReason === 'state'
  const quotaMinutes = Math.max(1, Math.ceil((quotaRetrySeconds ?? 60) / 60))

  /**
   * Account mode reads the persisted projection state first. Until a language
   * is complete, the local wordbook stays on screen (R2 upgrade) or a preparing
   * state is shown (new device). The projection is read only when complete.
   */
  useEffect(() => {
    if (localOnly) return
    void refreshReadiness(userId)
  }, [localOnly, lastSyncedAt, refreshReadiness, userId])

  useEffect(() => {
    if (!languageCode || localOnly || !projectionComplete) return
    void refreshFromStore(languageCode)
  }, [languageCode, localOnly, projectionComplete, refreshFromStore, lastSyncedAt])

  /**
   * The worker sorts and searches the projection off the main thread. Rebuild
   * only when the projection content changes — a status tap patches one row and
   * must not re-send 116k entries.
   */
  const [worker] = useState(() =>
    createWordbookWorkerClient({ role: 'wordbook' }),
  )
  useEffect(() => {
    return () => worker.terminate()
  }, [worker])

  const [sortedLemmas, setSortedLemmas] = useState<string[]>([])
  /**
   * The language whose first search has resolved. Local-only rows are shown
   * only after that, so loading the producer never flashes an empty list.
   * Keyed by language (not query) so typing keeps the previous ordering visible
   * instead of rebuilding the occurrence list on every keystroke.
   */
  const [sortedLanguage, setSortedLanguage] = useState<string | null>(null)

  useEffect(() => {
    if (localOnly || !languageCode || !projectionReady) return
    const entries = useWordbookStore.getState().entriesByLanguage[languageCode] ?? []
    void worker.rebuild(entries, languageCode).catch((error) => {
      console.error('단어장 정렬 실패', error)
    })
  }, [localOnly, languageCode, projectionReady, projectionRevision, worker])

  useEffect(() => {
    if (!languageCode || !projectionReady) return
    let cancelled = false
    const searching = localOnly
      ? searchLocalProjection(query, languageCode)
      : worker.search(query, languageCode)
    void searching
      .then((lemmas) => {
        if (cancelled) return
        setSortedLemmas(lemmas)
        setSortedLanguage(languageCode)
      })
      .catch((error) => {
        if (cancelled) return
        // The worker is an optimization, not a correctness dependency.
        console.error('단어장 검색 실패', error)
        const entries = useWordbookStore.getState().entriesByLanguage[languageCode] ?? []
        setSortedLemmas(searchProjectionEntries(entries, query, languageCode).map((entry) => entry.lemma))
        setSortedLanguage(languageCode)
      })
  }, [localOnly, languageCode, projectionReady, query, projectionRevision, worker])

  const rowSource = resolveWordbookRowSource({
    localOnly,
    presentation: presentation.source,
    projectionReady,
    sortedReady: sortedLanguage === languageCode,
  })

  /**
   * Local path: an account whose projection is still incomplete (R2 upgrade),
   * and local-only mode until the local producer's build and first search land.
   */
  const legacyEntries = useMemo(() => {
    if (rowSource === 'projection' || !localSource || !languageCode) return []
    return buildWordbook({
      languageCode,
      occurrences,
      byKey,
      documentId: effectiveDocumentId,
      query,
    })
  }, [
    rowSource,
    localSource,
    languageCode,
    occurrences,
    byKey,
    effectiveDocumentId,
    query,
  ])

  /**
   * Projection path: the worker returned matching lemmas in sorted order; this
   * maps them back to the rows already held on the main thread. A status edit
   * changes the row objects but not the order, so no worker round-trip is needed.
   */
  const projectionVisible = useMemo(() => {
    if (!projectionReady || !languageCode) return []
    const byLemma = new Map(projectionEntries.map((entry) => [entry.lemma, entry]))
    const matched = sortedLemmas
      .map((lemma) => byLemma.get(lemma))
      .filter((entry): entry is ProjectionWordbookEntry => entry !== undefined)
    if (!effectiveDocumentId) return matched
    return matched
      .map((entry) => scopeProjectionEntry(entry, effectiveDocumentId))
      .filter((entry): entry is ProjectionWordbookEntry => entry !== null)
  }, [projectionReady, languageCode, projectionEntries, sortedLemmas, effectiveDocumentId])

  /**
   * Local-only mode uses the same read model once its producer has built and
   * indexed it — same rows, same worker sorting, same scoping. An account's R2
   * upgrade keeps the occurrence-built list until the server projection is
   * complete.
   */
  const entries: WordbookEntry[] =
    rowSource === 'legacy' ? legacyEntries : projectionVisible
  const grouped = useMemo(() => groupByStatus(entries), [entries])

  /**
   * 언어나 상태 탭, 검색어, 쪽 수를 바꾸면 항상 첫 쪽으로 돌려보낸다.
   *
   * 목록이 줄어 마지막 쪽이 사라지는 경우까지 paginate 가 계산에서 당겨준다 —
   * 화면에 빈 쪽을 보여주지 않기 위해서다.
   */
  const resetPage = () => setPageNumber(1)

  /**
   * ★ 탭에서 별 색으로 좁히는 필터 (개선사항.txt).
   *
   * 여러 색을 겹쳐 켤 수 있다. 켠 색이 없으면 ★ 탭 전체다. 다른 탭에 옮겨
   * 가도 켠 색을 그대로 둔다 — 필터는 ★ 탭에만 걸리므로 다른 탭에 영향이
   * 없고, 돌아왔을 때 좁혀진 상태 그대로다.
   */
  const [starColors, setStarColors] = useState<string[]>([])
  const toggleStarColor = (hex: string) => {
    setStarColors((prev) =>
      prev.includes(hex) ? prev.filter((c) => c !== hex) : [...prev, hex],
    )
    resetPage()
  }

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

  /**
   * ★ 탭에만 색 필터가 걸린다 — 다른 탭은 건드리지 않는다.
   *
   * 색창이 없는 탭에 필터를 몰래 남겨 두면 좁혀진 목록을 보고 '단어가
   * 사라졌다' 고 읽는다. 탭 안에서만 좁히는 것이 그 것을 막는 길이다.
   */
  const visible = useMemo(() => {
    if (group !== 'favorite') return grouped[group]
    return filterByStarColors(grouped.favorite, starColors)
  }, [grouped, group, starColors])

  const current = useMemo(
    () => paginate(visible, pageNumber, pageSize),
    [visible, pageNumber, pageSize],
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
            : presentation.source === 'preparing'
              ? t('wordbook.preparing')
              : t('wordbook.summary', { count: entries.length })}
        </p>
      </header>

      {/* Paused by the 64 MB soft cap — continue runs the next sync/resume. */}
      {presentation.showPaused && (
        <div
          role="status"
          data-wordbook-paused
          className="border-status-unsure bg-status-unsure-bg mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2 text-xs"
        >
          <span className="text-status-unsure min-w-0 flex-1">
            <strong className="font-medium">
              {t(quotaPaused ? 'wordbook.quotaPaused' : statePaused ? 'wordbook.statePaused' : 'wordbook.paused')}
            </strong>{' '}
            {quotaPaused
              ? t('wordbook.quotaPausedHint', { minutes: quotaMinutes })
              : statePaused
                ? t('wordbook.statePausedHint')
                : t('wordbook.pausedHint')}
          </span>
          {presentation.showContinue && !quotaPaused && !statePaused && (
            <button
              type="button"
              data-wordbook-continue
              onClick={() => void syncNow()}
              className="border-status-unsure text-status-unsure shrink-0 rounded-md border px-2.5 py-1 font-medium hover:bg-surface"
            >
              {t('wordbook.pausedContinue')}
            </button>
          )}
        </div>
      )}

      {/*
        지금 보고 있는 범위의 통계를 먼저 보여 준다. 목록 아래에 두면 아래까지 스크롤한
        뒤에야 '얼마나 남았지' 를 알게 되는데, 그 판단이 먼저여야 고르기 시작할 수 있다.
        범위가 좁혀져 있으면 그 범위의 통계가 된다 — 같은 화면에서 다른 말을 하지 않는다.
      */}
      {presentation.source !== 'preparing' && (
        <div className="mb-4">
          <WordStatusChart counts={countsFromGroups(grouped)} />
        </div>
      )}

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

      {presentation.source === 'preparing' ? (
        <section
          role="status"
          data-wordbook-preparing
          className="border-line bg-surface mt-2 rounded-xl border px-4 py-6"
        >
          <h2 className="text-sm font-medium">{t('wordbook.preparing')}</h2>
          <p className="text-ink-muted mt-1 text-xs leading-relaxed">
            {t('wordbook.preparingHint')}
          </p>
          <p className="text-ink-muted mt-3 text-xs">
            {t('wordbook.preparingProgress', {
              ready: preparation.ready,
              total: preparation.total,
            })}
          </p>
          <div
            role="progressbar"
            aria-valuenow={preparation.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t('wordbook.preparing')}
            className="bg-line mt-2 h-1.5 w-full overflow-hidden rounded-full"
          >
            <span
              className="bg-accent block h-full rounded-full transition-[width]"
              style={{ width: `${preparation.percent}%` }}
            />
          </div>
        </section>
      ) : (
        <>
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

      {/* ★ 탭에서만 — 별 색으로 즐겨찾기를 좁힌다 (개선사항.txt) */}
      {group === 'favorite' && (
        <StarColorFilter active={starColors} onToggle={toggleStarColor} />
      )}

      {current.items.length === 0 ? (
        <p className="text-ink-muted py-8 text-sm">
          {group === 'favorite' && starColors.length > 0
            ? t('wordbook.starFilterEmpty')
            : t(`wordbook.empty.${group}`)}
        </p>
      ) : (
        <ul className="divide-line divide-y">
          {current.items.map((entry) => (
            <WordbookItem key={entry.lemma} entry={entry} languageCode={languageCode} />
          ))}
        </ul>
      )}

      <Pagination page={current} onPageChange={setPageNumber} />
        </>
      )}
    </section>
  )
}
