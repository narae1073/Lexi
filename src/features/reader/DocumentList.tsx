import { useMemo } from 'react'
import { Link } from 'react-router-dom'

import { useDocumentsStore } from '../../app/stores/documents'
import { useOccurrencesStore } from '../../app/stores/occurrences'
import { useLanguageName, useSettingsStore, useTranslation } from '../../app/stores/settings'
import { useWordStatesStore } from '../../app/stores/wordStates'
import { documentProgress, groupByDocument } from './documentProgress'
import { activeDocuments, DOCUMENT_SORTS, sortDocuments } from './documentSort'

export function DocumentList() {
  const t = useTranslation()
  const languageName = useLanguageName()
  const allDocuments = useDocumentsStore((s) => s.documents)
  const loading = useDocumentsStore((s) => s.loading)
  const occurrences = useOccurrencesStore((s) => s.occurrences)
  const byKey = useWordStatesStore((s) => s.byKey)
  const documentSort = useSettingsStore((s) => s.documentSort)
  const setDocumentSort = useSettingsStore((s) => s.setDocumentSort)
  const documentSortDir = useSettingsStore((s) => s.documentSortDir)
  const toggleDocumentSortDir = useSettingsStore((s) => s.toggleDocumentSortDir)

  /**
   * 문서별 진도를 한 번에 계산한다.
   *
   * 문서마다 따로 훅을 부르면 목록이 늘 때 hooks 순서가 달라져 버린다.
   * 게다가 상태를 표시할 때마다 문서를 전부 다시 훑는다 — memo 로 막는다.
   */
  const progressByDocument = useMemo(() => {
    const grouped = groupByDocument(occurrences)
    const result = new Map<string, ReturnType<typeof documentProgress>>()
    for (const [documentId, rows] of grouped) {
      const languageCode = rows[0]?.languageCode
      if (!languageCode) continue
      result.set(
        documentId,
        documentProgress(rows, (lemma) => byKey[`${languageCode}::${lemma}`]),
      )
    }
    return result
  }, [occurrences, byKey])

  // 휴지통에 있는 문서는 목록에 나오지 않는다 — 되살릴 곳이 있어야 한다
  const documents = useMemo(() => activeDocuments(allDocuments), [allDocuments])
  const trashedCount = allDocuments.length - documents.length

  const direction = documentSortDir[documentSort]
  const sorted = useMemo(
    () => sortDocuments(documents, documentSort, direction),
    [documents, documentSort, direction],
  )

  if (loading) return <p className="p-8 text-sm text-ink-muted">{t('list.loading')}</p>
  if (documents.length === 0) {
    return (
      <p className="text-ink-muted p-8 text-sm">
        {t('list.empty')}
        {trashedCount > 0 && (
          <>
            {' '}
            <Link to="/trash" className="text-accent underline">
              {t('list.trashCount', { count: trashedCount })}
            </Link>
          </>
        )}
      </p>
    )
  }

  return (
    <>
      <div className="border-line flex items-center justify-between gap-3 border-b px-5 py-2">
        <label className="text-ink-muted flex items-center gap-1.5 text-xs">
          {t('list.sortBy')}
          <select
            value={documentSort}
            onChange={(event) => setDocumentSort(event.target.value as typeof documentSort)}
            aria-label={t('list.sortBy')}
            className="border-line focus:border-accent rounded-lg border bg-surface px-2 py-1 text-sm outline-none"
          >
            {DOCUMENT_SORTS.map((option) => (
              <option key={option} value={option}>
                {t(`list.sort.${option}`)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2">
          {trashedCount > 0 && (
            <Link
              to="/trash"
              className="text-ink-muted hover:text-ink rounded-lg border border-line px-2 py-1 text-xs"
            >
              {t('list.trashCount', { count: trashedCount })}
            </Link>
          )}
          <button
            type="button"
            onClick={() => toggleDocumentSortDir(documentSort)}
            aria-label={t(`list.direction.${direction}`)}
            title={t(`list.direction.${direction}`)}
            className="border-line text-ink-muted hover:text-ink hover:border-accent rounded-lg border px-2 py-1 text-xs"
          >
            {t(`list.directionArrow.${direction}`)}
          </button>
          <span className="text-ink-muted text-xs">{t('list.sortHint')}</span>
        </div>
      </div>

      <ul className="divide-y divide-line">
      {sorted.map((doc) => (
        <li key={doc.id}>
          <Link
            to={`/read/${doc.id}`}
            className="flex items-center gap-3 px-5 py-3 hover:bg-surface-hover"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm font-medium">{doc.title}</span>
              <span className="text-ink-muted text-xs">
                {t('list.meta', {
                  language: languageName(doc.languageCode),
                  count: doc.rawText.trim().length,
                  date: new Date(doc.updatedAt).toLocaleString(),
                })}
              </span>
            </span>

            <ProgressGauge
              progress={progressByDocument.get(doc.id)}
              label={t('list.markedLabel')}
              text={(p) => t('list.marked', { percent: p.percent, marked: p.marked, total: p.total })}
            />
          </Link>
        </li>
      ))}
      </ul>
    </>
  )
}

/**
 * 오른쪽 진도 게이지.
 *
 * 기록이 없는 문서는 모르는 것이지 0% 가 아니므로 가로대와 숫자 대신 물음표를
 * 보여 준다. "0%" 라고 적어 두면 벌써 다 봤다고 오해할 수 있다.
 */
function ProgressGauge({
  progress,
  label,
  text,
}: {
  progress?: { total: number; marked: number; percent: number }
  label: string
  text: (p: { total: number; marked: number; percent: number }) => string
}) {
  if (!progress || progress.total === 0) {
    return (
      <span className="text-ink-muted shrink-0 text-xs" title={label}>
        —
      </span>
    )
  }

  return (
    <span className="flex shrink-0 flex-col items-end gap-1" title={label}>
      <span className="text-ink-muted text-[11px] tabular-nums">{text(progress)}</span>
      <span
        role="progressbar"
        aria-valuenow={progress.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className="bg-line block h-1 w-16 overflow-hidden rounded-full"
      >
        <span
          className="bg-accent block h-full rounded-full"
          style={{ width: `${progress.percent}%` }}
        />
      </span>
    </span>
  )
}