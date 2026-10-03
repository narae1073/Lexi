import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { useAnchoredPosition } from '../../lib/useAnchoredPosition'
import type { PopoverSize } from '../../lib/position'

const FALLBACK_SIZE: PopoverSize = { width: 224, height: 96 }

/** 사전 항목처럼 내용이 긴 경우 화면을 넘지 않도록 상한을 둔다 */
const MAX_CONTENT_HEIGHT = 'min(58vh, 420px)'

/**
 * 앵커 위에 뜨는 작은 박스 (plan.txt 3줄).
 *
 * 스크롤할 때 닫지 않고 위치를 다시 계산한다 — 본문을 읽다가 팝오버가 사라지면
 * 어느 단어를 확인 중인지 잃게 된다. PLAN.md §5.3은 닫도록 적혀 있으나 지면 변경.
 */
export function Popover({
  anchor,
  anchorKey,
  onClose,
  children,
  width = FALLBACK_SIZE.width,
}: {
  anchor: HTMLElement | null
  anchorKey: string | number
  onClose: () => void
  children: ReactNode
  width?: number
}) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<PopoverSize | null>(null)

  useLayoutEffect(() => {
    const el = popoverRef.current
    if (!el) return
    const next = { width: el.offsetWidth, height: el.offsetHeight }
    setSize((prev) => (prev && prev.width === next.width && prev.height === next.height ? prev : next))
  }, [children])

  const position = useAnchoredPosition(
    anchor,
    anchorKey,
    size?.width ?? FALLBACK_SIZE.width,
    size?.height ?? FALLBACK_SIZE.height,
  )

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target)) return
      if (anchor?.contains(target)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [anchor, onClose])

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      style={{
        position: 'fixed',
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        width,
        maxHeight: MAX_CONTENT_HEIGHT,
        // 위치를 재는 동안 깜빡이지 않게 숨긴다
        visibility: position ? 'visible' : 'hidden',
      }}
      className="pointer-events-none fixed flex flex-col overflow-hidden rounded-xl border border-line bg-surface p-2 shadow-lg shadow-black/20"
    >
      {/* 내용 영역은 스크롤되므로 이벤트를 받아야 한다.
          단, 이 박스가 아래 단어를 가리면 그 단어를 클릭할 수 없게 된다 —
          ESC/외부 클릭으로 닫고 다시 선택해야 한다. */}
      <div
        className="pointer-events-auto overflow-y-auto overscroll-contain"
        style={{ maxHeight: MAX_CONTENT_HEIGHT }}
      >
        {/* 스크롤 컨테이너의 직속 자식이 flex 로 잡히면 높이가 눌린다
            (제목이 4px 로 뭉개진 사례). 높이는 auto 로 둔다. */}
        <div className="flex flex-col gap-2">{children}</div>
      </div>
    </div>,
    document.body,
  )
}