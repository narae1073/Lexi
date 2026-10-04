import { useEffect, useState } from 'react'

/**
 * 화면 아래를 차지하는, 떠 있는 바의 높이.
 *
 * 상태 바는 fixed 로 화면 아래에 붙어 있다. 팝오버 자리를 계산할 때 뷰포트 전체를
 * 쓸 수 있는 공간으로 보면, 그 바를 덮는 자리가 나올 수 있다 — 바가 z-20 이라
 * 팝오버를 가려서,contents가 잘린 것처럼 보인다. 위를 고쳐도 아래를 덮는 자리가
 * 남으므로 아래쪽 여백을 줄여야 한다.
 *
 * 바의 높이는 내용에 따라 달라진다 — 좁은 화면에서는 범례가 줄을 바꾼다. 그래서
 * 높이를 한 번 재지 않고 지켜본다.
 */
const BOTTOM_BAR_SELECTOR = '[data-obstructs-bottom]'

/** 화면 아래에 붙어 있는 바들의 높이 합 */
export function measureBottomInset(): number {
  if (typeof document === 'undefined') return 0

  let inset = 0
  for (const element of document.querySelectorAll(BOTTOM_BAR_SELECTOR)) {
    const rect = element.getBoundingClientRect()
    // 화면 아래에 붙어 있는 것만 장애물이다 — 본문 중에 있는 요소는 해당하지 않는다
    if (rect.bottom >= window.innerHeight - 1) inset += rect.height
  }
  return inset
}

/** 아래쪽 장애물의 높이. 변하면 다시 준다 */
export function useBottomInset(): number {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    const update = () => {
      setInset((prev) => {
        const next = measureBottomInset()
        return Math.abs(prev - next) < 1 ? prev : next
      })
    }

    update()

    // 바가 여러 개일 수 있으므로 모두 지켜본다
    const observer = new ResizeObserver(update)
    for (const element of document.querySelectorAll(BOTTOM_BAR_SELECTOR)) {
      observer.observe(element)
    }

    window.addEventListener('resize', update)
    // 늦게 나타나는 바도 있으므로 한 번 더 잰다
    const retry = setTimeout(update, 300)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      clearTimeout(retry)
    }
  }, [])

  return inset
}