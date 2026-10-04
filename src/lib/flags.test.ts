import { describe, expect, it } from 'vitest'

import { isEnabled } from './flags'

describe('isEnabled', () => {
  it('켜짐으로 쓰는 값들을 받아들인다', () => {
    for (const raw of ['1', 'true', 'TRUE', 'yes', 'on', ' 1 ']) {
      expect(isEnabled(raw)).toBe(true)
    }
  })

  it('아무 값이 없거나 알 수 없는 값이면 꺼짐이다', () => {
    // provider 를 켜기 전에 배포하면 누가 눌렀을 때 실패하므로 기본은 꺼짐
    for (const raw of [undefined, null, '', '0', 'false', 'no', 'off', 'maybe']) {
      expect(isEnabled(raw)).toBe(false)
    }
  })
})
