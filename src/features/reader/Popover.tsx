import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { useBottomInset } from '../../lib/bottomInset'
import { useAnchoredPosition } from '../../lib/useAnchoredPosition'
import type { PopoverSize } from '../../lib/position'

const FALLBACK_SIZE: PopoverSize = { width: 224, height: 96 }

/** 화면 가장자리에서 남길 여백 */
const EDGE_MARGIN = 16

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
  ariaLabel,
}: {
  anchor: HTMLElement | null
  anchorKey: string | number
  onClose: () => void
  children: ReactNode
  width?: number
  /** Optional accessible name for non-modal dialogs such as confirmations. */
  ariaLabel?: string
}) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<PopoverSize | null>(null)

  /**
   * 아래쪽 상태 바의 높이를 뺀 만큼만 커지게 한다.
   *
   * 자리를 잘 계산해도 앵커가 낮으면 위 공간이 부족하다. 그러면 위쪽 경계로 밀려
   * 아래쪽이 상태 바를 덮는다 — 높이를 함께 줄여야 덮을 일이 없다.
   */
  const bottomInset = useBottomInset()
  const maxHeight = `min(58vh, 420px, calc(100vh - ${bottomInset}px - ${EDGE_MARGIN}px))`

  /**
   * 이 박스의 크기를 재고, 크기가 바뀌면 자리를 다시 잡는다.
   *
   * 자식 요소를 의존성으로 삼지 않는다. 사전은 DictionaryPanel 안에서만 그려지므로
   * 내용이 채워져도 이 박스는 다시 그려지지 않는다 — 그러면 첫 측정(로딩 한 줄 높이)
   * 이 끝까지 남아, 아래쪽 단어의 사전이 아래로 열려 화면 밖으로 나간다.
   * 닫았다 다시 열면 이번엔 처음부터 내용이 있어 위로 오른다. 같은 사전이 두 번
   * 다르게 놓이는 셈이다.
   *
   * 그래서 내용물의 크기 변화를 직접 지켜본다. 사전이 로드되자마자 높이가 커지므로
   * 그 즉시 방향을 뒤집는다.
   */
  useLayoutEffect(() => {
    const el = popoverRef.current
    if (!el) return

    const measure = () => {
      const next = { width: el.offsetWidth, height: el.offsetHeight }
      setSize((prev) =>
        prev && prev.width === next.width && prev.height === next.height ? prev : next,
      )
    }

    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

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
      aria-label={ariaLabel}
      style={{
        position: 'fixed',
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        width,
        maxHeight,
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
        style={{ maxHeight }}
      >
        {/* 스크롤 컨테이너의 직속 자식이 flex 로 잡히면 높이가 눌린다
            (제목이 4px 로 뭉개진 사례). 높이는 auto 로 둔다. */}
        <div className="flex flex-col gap-2">{children}</div>
      </div>
    </div>,
    document.body,
  )
}