import { useRef, useState } from 'react'

import { useDocumentsStore } from '../../app/stores/documents'
import { useFoldersStore } from '../../app/stores/folders'
import { useTranslation } from '../../app/stores/settings'
import { Popover } from '../reader/Popover'
import type { Document } from '../../types'

/**
 * 문서 한 장을 폴더로 옮기는 메뉴 (행 오른쪽의 작은 단추).
 *
 * 폴더에 없애는 것도 같은 길이다 — 'No folder' 가 그 역할이다. 저장소 쪽에서는
 * moveToFolder([id], null) 한 말로 옮기기가 끝난다.
 *
 * 중첩(다음 단계)을 깔면 이 목록은 나무가 된다. 지금은 뿌리 폴더만 둔다 —
 * 골라 담는 일과 보는 일이 같은 곳에서 시작하는 것이 목적이다.
 */
export function MoveToFolder({ doc }: { doc: Document }) {
  const t = useTranslation()
  const folders = useFoldersStore((s) => s.folders)
  const moveToFolder = useDocumentsStore((s) => s.moveToFolder)
  const [open, setOpen] = useState<HTMLElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const current = doc.folderId ?? null

  const pick = (folderId: string | null) => {
    void moveToFolder([doc.id], folderId)
    setOpen(null)
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(open ? null : (buttonRef.current ?? null))}
        aria-label={t('list.moveTo')}
        title={t('list.moveTo')}
        className="border-line text-ink-muted hover:border-accent shrink-0 rounded-lg border px-2 py-1 text-xs transition"
      >
        {t('list.move')}
      </button>
      {open && (
        <Popover anchor={open} anchorKey={`${doc.id}:move`} onClose={() => setOpen(null)} width={240}>
          <div role="listbox" aria-label={t('list.moveTo')} className="flex flex-col gap-0.5">
            <MoveOption
              label={t('list.noFolder')}
              selected={current === null}
              onPick={() => pick(null)}
            />
            {folders.map((folder) => (
              <MoveOption
                key={folder.id}
                label={folder.name}
                selected={current === folder.id}
                onPick={() => pick(folder.id)}
              />
            ))}
            {folders.length === 0 && (
              <p className="text-ink-muted py-2 text-center text-xs">{t('list.noFolderYet')}</p>
            )}
          </div>
        </Popover>
      )}
    </>
  )
}

function MoveOption({
  label,
  selected,
  onPick,
}: {
  label: string
  selected: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onPick}
      className={`text-xs transition rounded-lg px-2 py-1.5 text-left ${
        selected
          ? 'bg-accent text-accent-ink'
          : 'text-ink hover:bg-surface-hover'
      }`}
    >
      {label}
      {selected && <span aria-hidden> ✓</span>}
    </button>
  )
}
