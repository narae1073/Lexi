import { memo, type CSSProperties } from 'react'

import type { Segment } from '../../types'

/**
 * 본문의 단어 하나 + 즐겨찾기 별 스티커.
 *
 * 별은 가상요소(::after)로 얹는다 — DOM 자식으로 넣으면 textContent 와
 * Range.toString() 에 ★이 섞여 단어 클릭 매칭과 드래그 번역의 오프셋 계산이
 * 어긋난다. 클릭은 단어 본체로 그대로 간다 (별은 장식이라 이벤트를 받지 않는다).
 * 기울기는 단어마다 고정된 값이라 다시 그려도 덜덜 떨리지 않는다.
 */
export const WordWithStar = memo(function WordWithStar({
  segment,
  statusClassName,
  starred,
  tiltDegrees,
  starSize,
  starColor,
}: {
  segment: Extract<Segment, { type: 'word' }>
  statusClassName: string
  starred: boolean
  tiltDegrees: number
  starSize: number
  starColor: string
}) {
  return (
    <span
      data-start={segment.start}
      data-favorite={starred || undefined}
      style={
        starred
          ? ({
              '--star-tilt': `${tiltDegrees}deg`,
              '--star-size': `${starSize}%`,
              '--star-color': starColor,
            } as CSSProperties)
          : undefined
      }
      className={`cursor-pointer rounded-sm ${starred ? 'lexi-fav' : ''} ${statusClassName}`}
    >
      {segment.text}
    </span>
  )
})
