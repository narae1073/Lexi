import { useLayoutEffect, useState } from 'react'

import { useBottomInset } from './bottomInset'
import { computePopoverPosition } from './position'

/**
 * 팝오버를 앵커 요소에 붙이고, 스크롤·리사이즈·레이아웃 변화에 맞춰 위치를 다시 계산한다.
 * 모바일 주소창이 접혔다 펼칠 때도 rect가 바뀌므로 반드시 반응형이어야 한다.
 *
 * 앵커를 ref가 아니라 요소로 받는 이유: 새 선택이 반영되는 그 렌더에서 곧바로
 * 올바른 앵커를 읽어야 한다. ref는 레이아웃 이펙트 시점에는 아직 이전 값이다.
 *
 * 크기는 객체가 아니라 개별 숫자로 받는다 — 객체를 넘기면 매 렌더 새 참조가 되어
 * 이펙트가 무한히 다시 걸린다.
 */
export function useAnchoredPosition(
  anchor: HTMLElement | null,
  anchorKey: string | number,
  width: number,
  height: number,
) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  // 아래쪽 고정 바의 높이만큼 자리를 올려 준다 — 그 바를 덮지 않게
  const bottomInset = useBottomInset()

  useLayoutEffect(() => {
    if (!anchor) return

    const update = () => {
      const next = computePopoverPosition(
        anchor.getBoundingClientRect(),
        { width, height },
        { width: window.innerWidth, height: window.innerHeight, bottomInset },
      )
      setPosition((prev) =>
        prev && prev.left === next.left && prev.top === next.top
          ? prev
          : { left: next.left, top: next.top },
      )
    }

    update()

    const observer = new ResizeObserver(update)
    observer.observe(anchor)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)

    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [anchor, anchorKey, width, height, bottomInset])

  return position
}