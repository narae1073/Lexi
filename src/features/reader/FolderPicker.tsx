import { useMemo, useState, type ReactNode } from 'react'

import { useFoldersStore } from '../../app/stores/folders'
import { useTranslation } from '../../app/stores/settings'
import { Popover } from '../reader/Popover'
import { ancestorsOf, childrenOf, descendantsOf, visibleRoots } from './folderTree'

/**
 * 옮길 곳을 고르는 작은 나무 상자 — 뿌리부터 한 층씩 펼친다.
 *
 * 옮기는 폴더와 그 자손은 보여 주되 고를 수 없다 — 부모를 자식 안으로 넣으면
 * 순환이 만들어져 목록이 영원히 열리지 않는다. 지금 있는 폴더의 가지는
 * 처음부터 펼쳐 둔다.
 */
export function FolderPicker({
  anchor,
  anchorKey,
  lockedIds,
  currentId,
  onPick,
  onClose,
}: {
  anchor: HTMLElement | null
  anchorKey: string | number
  /** 옮기는 폴더 — 이것과 그 자손은 잠긴다 */
  lockedIds: readonly string[]
  /** 지금 있는 폴더 — 그 가지는 처음부터 펼쳐 둔다 (없으면 뿌리만 보인다) */
  currentId?: string | null
  onPick: (id: string | null) => void
  onClose: () => void
}) {
  const t = useTranslation()
  const folders = useFoldersStore((s) => s.folders)

  /** 잠긴 자리 — 옮기는 폴더와 그 아래 전부 */
  const locked = useMemo(() => {
    const ids = new Set<string>(lockedIds)
    for (const id of lockedIds) {
      for (const child of descendantsOf(folders, id)) ids.add(child.id)
    }
    return ids
  }, [folders, lockedIds])

  /** 처음부터 펼쳐 둘 가지 — 지금 있는 폴더의 조상들 */
  const auto = useMemo(
    () =>
      new Set(
        currentId
          ? ancestorsOf(folders, currentId)
              .map((folder) => folder.id)
              .filter((id) => !locked.has(id))
          : [],
      ),
    [folders, currentId, locked],
  )
  const [extraOpen, setExtraOpen] = useState<readonly string[]>([])
  const [shut, setShut] = useState<readonly string[]>([])
  const isOpen = (id: string) =>
    (auto.has(id) || extraOpen.includes(id)) && !shut.includes(id)
  const toggle = (id: string) => {
    if (isOpen(id)) {
      setShut((prev) => [...prev, id])
      setExtraOpen((prev) => prev.filter((x) => x !== id))
    } else {
      setShut((prev) => prev.filter((x) => x !== id))
      setExtraOpen((prev) => [...prev, id])
    }
  }

  const renderLevel = (parentId: string | null, depth: number): ReactNode => {
    const level = parentId === null ? visibleRoots(folders) : childrenOf(folders, parentId)
    return level.map((folder) => {
      const kids = childrenOf(folders, folder.id)
      const frozen = locked.has(folder.id)
      const open = isOpen(folder.id)
      return (
        <span key={folder.id}>
          <span
            role="option"
            aria-selected={false}
            aria-disabled={frozen || undefined}
            title={frozen ? t('list.moveLocked') : undefined}
            className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-left text-xs ${
              frozen ? 'text-ink-muted opacity-60' : ''
            }`}
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
            {frozen ? (
              <span className="min-w-0 flex-1 truncate">
                <span aria-hidden>📁 </span>
                {folder.name}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onPick(folder.id)}
                className="min-w-0 flex-1 truncate text-left"
              >
                <span aria-hidden>📁 </span>
                {folder.name}
              </button>
            )}
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
