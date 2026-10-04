/** 팝오버 앵커 위치 계산 (PLAN.md §5.3) */

export type Placement = 'top' | 'bottom'

export type PopoverSize = { width: number; height: number }

export type PopoverPosition = {
  left: number
  top: number
  placement: Placement
  /** 앵커와 겹쳐 화면 밖으로 나갔는지 — 뒤집기가 필요함을 알린다 */
  flipped: boolean
}

/**
 * 앵커 rect를 기준으로 팝오버 좌표를 잡는다.
 * 화면 밖으로 나가면 위/아래를 뒤집고, 그래도 넘치면 가장자리로 밀어 넣는다.
 *
 * bottomInset 은 화면 아래를 차지하는 고정 바(상태 바)의 높이다. 뷰포트 전체를
 * 쓸 수 있는 공간으로 보면 그 바를 덮는 자리가 나온다 — 바가 위에 그려지므로
 * 팝오버가 잘린 것처럼 보인다. 아래쪽 여백에서 그만큼 뺀다.
 */
export function computePopoverPosition(
  anchor: DOMRect,
  size: PopoverSize,
  viewport: { width: number; height: number; bottomInset?: number },
  gap = 8,
  margin = 8,
): PopoverPosition {
  const usable = viewport.height - (viewport.bottomInset ?? 0)
  const spaceBelow = usable - anchor.bottom - gap - margin
  const spaceAbove = anchor.top - gap - margin
  const placement: Placement = spaceBelow >= size.height || spaceBelow >= spaceAbove ? 'bottom' : 'top'

  const rawTop = placement === 'bottom' ? anchor.bottom + gap : anchor.top - gap - size.height

  const left = clamp(anchor.left + anchor.width / 2 - size.width / 2, margin, viewport.width - size.width - margin)
  const top = clamp(rawTop, margin, usable - size.height - margin)

  return { left, top, placement, flipped: placement === 'top' && rawTop !== top }
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}