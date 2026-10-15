import { useEffect, useRef, useState } from 'react'

import { useFoldersStore } from '../../app/stores/folders'
import { childrenOf } from '../../features/reader/folderTree'
import { useTranslation } from '../../app/stores/settings'
import { FolderMenu } from './FolderMenu'
import type { Folder } from '../../types'

/**
 * 문서 목록의 폴더 칩 줄.
 *
 * 폴더는 문서를 가두는 상자가 아니라는 점이 중요하다 — '전체' 칩이 언제나
 * 있으므로 모든 문서를 볼 수 있다 (단어장의 언어 칩과 같은 모양이다).
 *
 * 뿌리 폴더만 올린다 — 중첩은 다음 단계이고, parent_id 는 이미 모델에 있으므로
 * 중첩을 깔 때 두 번째 마이그레이션은 필요 없다.
 */
export function FolderChips({
  folderId,
  onPick,
}: {
  /** 지금 보고 있는 폴더. null 이면 전체다 */
  folderId: string | null
  onPick: (id: string | null) => void
}) {
  const t = useTranslation()
  const folders = useFoldersStore((s) => s.folders)
  const createFolder = useFoldersStore((s) => s.create)

  /** 이름 만들기가 열려 있는가 */
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState('')
  const [menuFor, setMenuFor] = useState<{ folder: Folder; anchor: HTMLElement } | null>(null)

  const roots = childrenOf(folders, null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!creating) return
    inputRef.current?.focus()
  }, [creating])

  /**
   * 새 폴더를 만들고 곧바로 그 폴더로 간다 — 만들려고 누른 것이니 그곳이 다음
   * 자리다. 빈 이름은 받지 않는다 (제목 없는 폴더는 길을 잃는다).
   */
  const commitCreate = async () => {
    const created = await createFolder(draft)
    setCreating(false)
    setDraft('')
    if (created) onPick(created.id)
  }

  const cancelCreate = () => {
    setCreating(false)
    setDraft('')
  }

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 px-5">
      {/* 전체 — 폴더는 문서를 가두지 않는다 */}
      <button
        type="button"
        onClick={() => onPick(null)}
        aria-pressed={folderId === null}
        className={
          folderId === null
            ? 'rounded-lg border border-accent bg-accent px-3 py-1.5 text-sm text-accent-ink'
            : 'border-line text-ink-muted hover:border-accent rounded-lg border px-3 py-1.5 text-sm transition'
        }
      >
        {t('list.folderAll')}
      </button>

      {roots.map((folder) => (
        <FolderChip
          key={folder.id}
          folder={folder}
          active={folderId === folder.id}
          onPick={() => onPick(folder.id)}
          onMenu={(anchor) => setMenuFor({ folder, anchor })}
        />
      ))}

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
            className="w-32 bg-transparent text-sm outline-none"
          />
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="border-line text-ink-muted hover:border-accent rounded-lg border px-2.5 py-1.5 text-sm transition"
        >
          + {t('list.newFolder')}
        </button>
      )}

      {menuFor && (
        <FolderMenu
          folder={menuFor.folder}
          anchor={menuFor.anchor}
          onClose={() => setMenuFor(null)}
        />
      )}
    </div>
  )
}

function FolderChip({
  folder,
  active,
  onPick,
  onMenu,
}: {
  folder: Folder
  active: boolean
  onPick: () => void
  onMenu: (anchor: HTMLElement) => void
}) {
  const t = useTranslation()
  const menuRef = useRef<HTMLButtonElement>(null)

  return (
    <span
      className={
        active
          ? 'flex items-center gap-1 rounded-lg border border-accent bg-accent px-2.5 py-1 text-sm text-accent-ink'
          : 'text-ink-muted flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-sm transition hover:border-accent'
      }
    >
      <button
        type="button"
        onClick={onPick}
        aria-pressed={active}
        className="max-w-[12rem] truncate"
      >
        {folder.name}
      </button>
      {/*
        활성 칩에만 메뉴 단추를 둔다 — 꺼진 칩마다 단추가 두 개면 고리는 일과
        메뉴 여는 일이 경쟁하게 되고, 보통은 폴더로 가려는 것이다.
      */}
      {active && (
        <button
          ref={menuRef}
          type="button"
          onClick={() => onMenu(menuRef.current!)}
          aria-label={t('list.folderMenu')}
          title={t('list.folderMenu')}
          className="opacity-80"
        >
          ⋯
        </button>
      )}
    </span>
  )
}
