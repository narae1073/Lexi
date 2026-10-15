import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { useDocumentsStore } from '../../app/stores/documents'
import { useFoldersStore } from '../../app/stores/folders'
import { useOccurrencesStore } from '../../app/stores/occurrences'
import { useLanguageName, useSettingsStore, useTranslation } from '../../app/stores/settings'
import { useWordStatesStore } from '../../app/stores/wordStates'
import { documentProgress, groupByDocument } from './documentProgress'
import { FolderMenu } from './FolderMenu'
import { FolderPicker } from './FolderPicker'
import {
  activeDocuments,
  documentLanguageFilterOrDefault,
  DOCUMENT_SORTS,
  documentsOfLanguage,
  languagesWithDocuments,
  sortDocuments,
} from './documentSort'
import { childrenOf, folderOfDocument, pruneNestedTicks, visibleRoots } from './folderTree'
import type { Folder } from '../../types'

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
  /** 저장된 언어 필터 — 문서를 본 뒤에 실제로 걸릴지 정한다 */
  const storedLanguageFilter = useSettingsStore((s) => s.documentLanguageFilter)
  const setDocumentLanguageFilter = useSettingsStore((s) => s.setDocumentLanguageFilter)
  const folders = useFoldersStore((s) => s.folders)
  const createFolder = useFoldersStore((s) => s.create)
  const trashDoc = useDocumentsStore((s) => s.trash)
  const moveDocs = useDocumentsStore((s) => s.moveToFolder)
  const deleteFolder = useFoldersStore((s) => s.deleteFolder)
  const moveFolder = useFoldersStore((s) => s.moveFolder)

  /**
   * 문서 목록의 자리 — 조상들의 꼬리표다 (마지막이 지금 있는 폴더, 비었으면 뿌리).
   *
   * 주소가 아니라 앱 안의 상태다 — 새로고침하면 뿌리로 돌아간다.
   * 보고 있던 폴더가 사라지면(다른 기기의 지우기) 꼬리의 죽은 끝을 떼어 내
   * 가장 가까운 살아 있는 조상으로 돌아간다.
   */
  const [path, setPath] = useState<string[]>([])
  const liveIds = useMemo(() => new Set(folders.map((f) => f.id)), [folders])
  const validPath = useMemo(() => {
    const next = [...path]
    while (next.length > 0 && !liveIds.has(next[next.length - 1])) next.pop()
    return next
  }, [path, liveIds])
  const folderId: string | null =
    validPath.length > 0 ? validPath[validPath.length - 1] : null
  const currentFolder = folderId ? (folders.find((f) => f.id === folderId) ?? null) : null

  const enterFolder = (id: string) => setPath([...validPath, id])
  const goBack = () => setPath(validPath.slice(0, -1))

  /**
   * 골라 담기 — 손·마우스 공통의 유일한 이동/버리기 입구다.
   *
   * 체크는 문서와 폴더 두 자루로 든다 (id 가 겹칠 수 있으므로). 필터·정렬을
   * 바꿔 가려진 줄도 그대로 옮겨가므로, 바에 살아 있는 셈을 둔다.
   */
  const [selecting, setSelecting] = useState(false)
  const [tickedDocIds, setTickedDocIds] = useState<Set<string>>(new Set())
  const [tickedFolderIds, setTickedFolderIds] = useState<Set<string>>(new Set())
  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null)

  const enterSelect = () => {
    setTickedDocIds(new Set())
    setTickedFolderIds(new Set())
    setSelecting(true)
  }
  const exitSelect = () => {
    setSelecting(false)
    setTickedDocIds(new Set())
    setTickedFolderIds(new Set())
    setPickerAnchor(null)
  }
  const toggleId = (set: Set<string>, apply: (next: Set<string>) => void, id: string) => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    apply(next)
  }
  const toggleDoc = (id: string) => toggleId(tickedDocIds, setTickedDocIds, id)
  const toggleFolder = (id: string) => toggleId(tickedFolderIds, setTickedFolderIds, id)

  /** 골라 담은 것을 휴지통에 — 문서는 되살릴 수 있고, 폴더는 부모로 옮겨 간다 */
  const bulkTrash = async () => {
    for (const id of tickedDocIds) await trashDoc(id)
    for (const id of pruneNestedTicks(folders, [...tickedFolderIds])) {
      await deleteFolder(id)
    }
    exitSelect()
  }

  /**
   * 골라 담은 것을 한 곳으로 옮긴다 — 문서와 폴더가 같은 길을 간다.
   *
   * 폴더는 껍데기만 옮긴다 (담긴 것은 딸려 간다). 겹쳐 체크된 자손은
   * 무시한다 — 부모 안에 딸려 가므로 따로 옮길 필요가 없다.
   */
  const bulkMove = async (target: string | null) => {
    if (tickedDocIds.size > 0) await moveDocs([...tickedDocIds], target)
    for (const id of pruneNestedTicks(folders, [...tickedFolderIds])) {
      await moveFolder(id, target)
    }
    exitSelect()
  }

  // 골라 담는 중의 Esc 는 고르기를 그만둔다 — 옮길 곳 고르기가 열려 있으면
  // 그쪽이 먼저 닫힌다 (Popover 자신의 Esc 처리)
  useEffect(() => {
    if (!selecting) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pickerAnchor) exitSelect()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [selecting, pickerAnchor])

  /** 이름 만들기가 열려 있는가 */
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!creating) return
    inputRef.current?.focus()
  }, [creating])

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

  /**
   * 언어 필터는 두 문지기를 거친다.
   *
   * 문서가 한 언어뿐이면 드롭다운을 아예 숨긴다 — 좁힐 필요가 없는 데 보여만
   * 놓는 것은 자리만 먹는다. 그리고 드롭다운은 실제 문서가 있는 언어만
   * 올리므로, 저장된 언어가 그 목록에 없으면(그 언어의 문서를 전부 버렸다)
   * 조용히 전체로 돌아간다.
   */
  const presentLanguages = useMemo(
    () => languagesWithDocuments(documents),
    [documents],
  )
  const showLanguageFilter = presentLanguages.length > 1
  const languageFilter =
    showLanguageFilter && storedLanguageFilter && presentLanguages.includes(storedLanguageFilter)
      ? storedLanguageFilter
      : null

  /** 지금 자리의 직접 아이 폴더 — 뿌리에서는 부모 잃은 폴더도 뿌리로 올린다 */
  const visibleFolders = useMemo(
    () => (folderId === null ? visibleRoots(folders) : childrenOf(folders, folderId)),
    [folders, folderId],
  )

  const direction = documentSortDir[documentSort]
  /** 폴더 → 언어 → 정렬 — 골라 담은 실제 손글씨를 남겨 둔다 */
  const inFolder = useMemo(
    () =>
      folderId === null
        ? documents.filter((doc) => folderOfDocument(folders, doc.folderId) === null)
        : documents.filter((doc) => (doc.folderId ?? null) === folderId),
    [documents, folders, folderId],
  )
  const filtered = useMemo(
    () => documentsOfLanguage(inFolder, languageFilter),
    [inFolder, languageFilter],
  )
  const sorted = useMemo(
    () => sortDocuments(filtered, documentSort, direction),
    [filtered, documentSort, direction],
  )

  /**
   * 새 폴더를 만들고 곧바로 그 폴더로 간다 — 만들려고 누른 것이니 그곳이 다음
   * 자리다. 빈 이름은 받지 않는다 (제목 없는 폴더는 길을 잃는다).
   */
  const commitCreate = async () => {
    const created = await createFolder(draft, folderId)
    setCreating(false)
    setDraft('')
    if (created) setPath([...validPath, created.id])
  }

  const cancelCreate = () => {
    setCreating(false)
    setDraft('')
  }

  if (loading) return <p className="p-8 text-sm text-ink-muted">{t('list.loading')}</p>
  if (documents.length === 0 && folders.length === 0) {
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
      {/* 자리 머리 — 뿌리에서는 '전체 문서', 폴더 안에서는 뒤로 + 폴더 이름 */}
      <div className="border-line flex items-center gap-2 border-b px-5 py-2">
        {currentFolder ? (
          <>
            <button
              type="button"
              onClick={goBack}
              aria-label={t('list.backButton')}
              title={t('list.backButton')}
              className="border-line text-ink-muted hover:text-ink hover:border-accent rounded-lg border px-2 py-1 text-xs"
            >
              ←
            </button>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">
              {currentFolder.name}
            </span>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">
            {t('list.folderAll')}
          </span>
        )}
        {selecting ? (
          <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={(event) => setPickerAnchor(event.currentTarget)}
              className="border-accent bg-accent text-accent-ink rounded-lg border px-2 py-1 text-xs"
            >
              {t('list.moveSelectedToFolder')}
            </button>
            <button
              type="button"
              onClick={() => void bulkTrash()}
              className="border-line text-ink-muted hover:text-ink hover:border-accent rounded-lg border px-2 py-1 text-xs"
            >
              {t('list.moveSelectedToTrash')}
            </button>
            <span className="text-ink-muted text-xs">
              {t('list.selectedCount', {
                count: tickedDocIds.size + tickedFolderIds.size,
              })}
            </span>
            <button
              type="button"
              onClick={exitSelect}
              className="text-ink-muted hover:text-ink rounded-lg px-2 py-1 text-xs"
            >
              {t('list.cancelSelect')}
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={enterSelect}
            className="border-line text-ink-muted hover:text-ink hover:border-accent shrink-0 rounded-lg border px-2 py-1 text-xs"
          >
            {t('list.selectDocuments')}
          </button>
        )}
      </div>
      <div className="border-line flex flex-wrap items-center justify-between gap-3 border-b px-5 py-2">
        <div className="flex flex-wrap items-center gap-3">
          {showLanguageFilter && (
            <label className="text-ink-muted flex items-center gap-1.5 text-xs">
              {t('list.language')}
              <select
                value={languageFilter ?? ''}
                onChange={(event) =>
                  setDocumentLanguageFilter(documentLanguageFilterOrDefault(event.target.value))
                }
                aria-label={t('list.language')}
                className="border-line focus:border-accent rounded-lg border bg-surface px-2 py-1 text-sm outline-none"
              >
                <option value="">{t('list.allLanguages')}</option>
                {presentLanguages.map((code) => (
                  <option key={code} value={code}>
                    {languageName(code)}
                  </option>
                ))}
              </select>
            </label>
          )}
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
        </div>
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

      {/*
        빈 곳이 '문서가 없다' 고 읽히지 않게 — 폴더·언어의 말이 먼저다.
        머리 줄이 위에 살아 있으므로 여기서 벗어나는 길은 언제나 있다.
      */}
      {sorted.length === 0 && visibleFolders.length === 0 ? (
        <p className="text-ink-muted px-5 py-8 text-sm">
          {folderId !== null
            ? t('list.emptyFolder')
            : languageFilter
              ? t('list.emptyForLanguage', { language: languageName(languageFilter) })
              : t('list.empty')}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {visibleFolders.map((folder) => (
            <FolderRow
              key={folder.id}
              folder={folder}
              selecting={selecting}
              ticked={tickedFolderIds.has(folder.id)}
              onEnter={() => enterFolder(folder.id)}
              onToggle={() => toggleFolder(folder.id)}
            />
          ))}
          {sorted.map((doc) =>
            selecting ? (
              <li key={doc.id} className="flex items-stretch gap-1">
                <button
                  type="button"
                  onClick={() => toggleDoc(doc.id)}
                  aria-pressed={tickedDocIds.has(doc.id)}
                  className="flex min-w-0 flex-1 items-center gap-3 px-5 py-3 text-left hover:bg-surface-hover"
                >
                  <CheckBadge on={tickedDocIds.has(doc.id)} />
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
                </button>
              </li>
            ) : (
              <li key={doc.id} className="flex items-stretch gap-1">
                <Link
                  to={`/read/${doc.id}`}
                  className="flex min-w-0 flex-1 items-center gap-3 px-5 py-3 hover:bg-surface-hover"
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
                    text={(p) =>
                      t('list.marked', { percent: p.percent, marked: p.marked, total: p.total })
                    }
                  />
                </Link>
              </li>
            ),
          )}
        </ul>
      )}

      {/* 옮길 곳 고르기 — 작은 나무 상자. 옮기는 폴더와 그 자손은 잠긴다 */}
      {pickerAnchor && (
        <FolderPicker
          anchor={pickerAnchor}
          anchorKey="bulk-move"
          lockedIds={pruneNestedTicks(folders, [...tickedFolderIds])}
          currentId={folderId}
          onPick={(target) => void bulkMove(target)}
          onClose={() => setPickerAnchor(null)}
        />
      )}

      {/* 새 폴더 — 지금 있는 자리에 만든다 */}
      <div className="px-5 py-3">
        {creating ? (
          <span className="border-accent flex items-center rounded-lg border px-2 py-1">
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => void commitCreate()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void commitCreate()
                if (event.key === 'Escape') cancelCreate()
              }}
              aria-label={t('list.folderNamePlaceholder')}
              placeholder={t('list.folderNamePlaceholder')}
              className="w-full bg-transparent text-sm outline-none"
            />
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="text-ink-muted hover:text-ink text-sm"
          >
            + {folderId === null ? t('list.newFolder') : t('list.newSubfolder')}
          </button>
        )}
      </div>
    </>
  )
}

/**
 * 폴더 한 줄 — 누르면 그 안으로 들어간다.
 *
 * ⋯는 자기 자리만 여는 별도 단추다 — 눌러도 들어가지 않는다.
 * 골라 담는 중에는 줄을 누르면 체크가 바뀌고, ⋯는 숨는다.
 */
function FolderRow({
  folder,
  selecting,
  ticked,
  onEnter,
  onToggle,
}: {
  folder: Folder
  selecting: boolean
  ticked: boolean
  onEnter: () => void
  onToggle: () => void
}) {
  const t = useTranslation()
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)

  return (
    <li className="flex items-stretch gap-1">
      <button
        type="button"
        onClick={selecting ? onToggle : onEnter}
        aria-pressed={selecting ? ticked : undefined}
        className="flex min-w-0 flex-1 items-center gap-3 px-5 py-3 text-left hover:bg-surface-hover"
      >
        {selecting && <CheckBadge on={ticked} />}
        <span aria-hidden>📁</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{folder.name}</span>
      </button>
      {!selecting && (
        <span className="flex flex-col justify-center pr-4">
          <button
            type="button"
            onClick={(event) => setMenuAnchor(event.currentTarget)}
            aria-label={t('list.folderMenu')}
            title={t('list.folderMenu')}
            className="text-ink-muted hover:text-ink rounded-lg px-2 py-1 text-sm"
          >
            ⋯
          </button>
        </span>
      )}
      {menuAnchor && (
        <FolderMenu folder={folder} anchor={menuAnchor} onClose={() => setMenuAnchor(null)} />
      )}
    </li>
  )
}

/** 골라 담기의 체크 표시 — 줄 전체가 단추이므로 표시는 장식이다 */
function CheckBadge({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] leading-none ${
        on ? 'border-accent bg-accent text-accent-ink' : 'border-line text-transparent'
      }`}
    >
      ✓
    </span>
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
