import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

import { useTranslation } from '../../app/stores/settings'

/**
 * 위험한 단추를 한 번 더 묻는 상자 — 화면 한가운데에 뜬다.
 *
 * 앵커에 붙는 Popover 와는 다른 자리다. 지우기·버리기는 보고 있던 곳을
 * 떠나게 하므로, 어디를 눌렀든 같은 곳에서 묻는다. Esc·바깥·그만두기는
 * 모두 그만두기다 — 실수로 지워지는 쪽으로는 절대 가지 않는다.
 * 처음부터 그만두기에 초점을 둔다 (Enter 가 지우기를 누르지 않게).
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string
  body: string
  confirmLabel: string
  onConfirm: () => void
  onClose: () => void
}) {
  const t = useTranslation()
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <button
        type="button"
        aria-label={t('confirm.cancel')}
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="border-line relative w-full max-w-xs rounded-xl border bg-surface p-4 shadow-lg shadow-black/20"
      >
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-ink-muted mt-1 text-xs">{body}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            className="border-line text-ink-muted hover:text-ink hover:border-accent rounded-lg border px-3 py-1.5 text-sm"
          >
            {t('confirm.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="border-status-unknown bg-status-unknown-bg text-status-unknown rounded-lg border px-3 py-1.5 text-sm"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
