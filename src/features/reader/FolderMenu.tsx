import { useState } from 'react'

import { useFoldersStore } from '../../app/stores/folders'
import { useTranslation } from '../../app/stores/settings'
import { Popover } from '../reader/Popover'
import type { Folder } from '../../types'

/**
 * 폴더 하나의 메뉴 — 이름 바꾸기, 지우기.
 *
 * 지우기에 확인 창을 두지 않는다. 폴더를 지워도 문서는 부모 폴더로 옮겨 가므로,
 * 이것은 되살릴 방법이 항상 열려 있는 실수가 아니다.
 */
export function FolderMenu({
  folder,
  anchor,
  onClose,
}: {
  folder: Folder
  anchor: HTMLElement
  onClose: () => void
}) {
  const t = useTranslation()
  const renameFolder = useFoldersStore((s) => s.rename)
  const deleteFolder = useFoldersStore((s) => s.deleteFolder)

  const [draft, setDraft] = useState(folder.name)

  const commit = async () => {
    await renameFolder(folder.id, draft)
    onClose()
  }

  return (
    <Popover anchor={anchor} anchorKey={`${folder.id}:menu`} onClose={onClose} width={240}>
      <div className="flex flex-col gap-1.5">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={200}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void commit()
            if (event.key === 'Escape') onClose()
          }}
          aria-label={t('list.folderNamePlaceholder')}
          className="border-line focus:border-accent w-full rounded-lg border px-2 py-1 text-sm outline-none"
        />
        <button
          type="button"
          onClick={() => void commit()}
          disabled={draft.trim() === folder.name || !draft.trim()}
          className="border-line hover:border-accent rounded-lg border px-2 py-1 text-xs transition disabled:opacity-40"
        >
          {t('list.renameFolder')}
        </button>
        <button
          type="button"
          onClick={() => {
            void deleteFolder(folder.id)
            onClose()
          }}
          className="text-status-unknown hover:border-status-unknown hover:text-status-unknown rounded-lg border border-line px-2 py-1 text-xs transition"
        >
          {t('list.deleteFolder')}
        </button>
      </div>
    </Popover>
  )
}
