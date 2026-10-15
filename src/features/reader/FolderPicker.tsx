import { useState, type ReactNode } from 'react'

import { useFoldersStore } from '../../app/stores/folders'
import { useTranslation } from '../../app/stores/settings'
import { Popover } from '../reader/Popover'
import { childrenOf, visibleRoots } from './folderTree'

/**
 * 옮길 곳을 고르는 작은 나무 상자 — 뿌리부터 한 층씩 펼친다.
 *
 * Task 6의 껍데기: 나무 보기 + '폴더 없음'만 있고, 고르면 닫기만 한다.
 * Task 7에서 잠금(옮기는 폴더와 그 자손은 고를 수 없음)과 실제 옮기기를 채운다.
 */
export function FolderPicker({
  anchor,
  anchorKey,
  lockedIds,
  onPick,
  onClose,
}: {
  anchor: HTMLElement | null
  anchorKey: string | number
  lockedIds: readonly string[]
  onPick: (id: string | null) => void
  onClose: () => void
}) {
  const t = useTranslation()
  const folders = useFoldersStore((s) => s.folders)
  // 껍데기에서는 쓰지 않는다 — Task 7의 잠금 표시가 이 값을 쓴다
  void lockedIds

  /** 펼쳐 놓은 폴더 — 뿌리 줄은 언제나 보인다 */
  const [expanded, setExpanded] = useState<readonly string[]>([])
  const toggle = (id: string) =>
    setExpanded((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const renderLevel = (parentId: string | null, depth: number): ReactNode => {
    const level = parentId === null ? visibleRoots(folders) : childrenOf(folders, parentId)
    return level.map((folder) => {
      const kids = childrenOf(folders, folder.id)
      const open = expanded.includes(folder.id)
      return (
        <span key={folder.id}>
          <span
            role="option"
            aria-selected={false}
            className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-left text-xs"
            style={{ paddingLeft: 8 + depth * 16 }}
          >
            {kids.length > 0 ? (
              <button
                type="button"
                onClick={() => toggle(folder.id)}
                aria-label={open ? '▾' : '▸'}
                className="text-ink-muted shrink-0 px-1"
              >
                {open ? '▾' : '▸'}
              </button>
            ) : (
              <span className="text-ink-muted shrink-0 px-1" aria-hidden>
                ·
              </span>
            )}
            <button type="button" onClick={() => onPick(folder.id)} className="min-w-0 flex-1 truncate text-left">
              <span aria-hidden>📁 </span>
              {folder.name}
            </button>
          </span>
          {open && renderLevel(folder.id, depth + 1)}
        </span>
      )
    })
  }

  return (
    <Popover anchor={anchor} anchorKey={anchorKey} onClose={onClose} width={240}>
      <div role="listbox" aria-label={t('list.moveTo')} className="flex flex-col gap-0.5">
        <button
          type="button"
          role="option"
          aria-selected={false}
          onClick={() => onPick(null)}
          className="text-ink hover:bg-surface-hover rounded-lg px-2 py-1.5 text-left text-xs transition"
        >
          🚫 {t('list.noFolder')}
        </button>
        {renderLevel(null, 0)}
      </div>
    </Popover>
  )
}
