import { describe, expect, it } from 'vitest'

import { useLanguagesStore } from './languages'

const codes = () => useLanguagesStore.getState().enrolled

const reset = () => useLanguagesStore.setState({ enrolled: [], ready: false })

describe('언어를 여러 개 고른다', () => {
  it('고르는 중에는 다음 화면으로 넘어가지 않는다', () => {
    reset()
    useLanguagesStore.getState().toggle('en')
    // 하나만 골랐는데 바로 넘어가면 고르는 중에도 저장이 되므로 튕겨 나간다
    expect(useLanguagesStore.getState().ready).toBe(false)
  })

  it('여러 개를 고를 수 있다', () => {
    reset()
    useLanguagesStore.getState().toggle('en')
    useLanguagesStore.getState().toggle('fr')
    useLanguagesStore.getState().toggle('de')
    expect(codes()).toEqual(['en', 'fr', 'de'])
    expect(useLanguagesStore.getState().ready).toBe(false)
  })

  it('고른 것을 다시 누르면 빠진다', () => {
    reset()
    useLanguagesStore.getState().toggle('en')
    useLanguagesStore.getState().toggle('fr')
    useLanguagesStore.getState().toggle('en')
    expect(codes()).toEqual(['fr'])
  })

  it('마쳐야 넘어간다', () => {
    reset()
    useLanguagesStore.getState().toggle('en')
    useLanguagesStore.getState().toggle('ko')
    expect(useLanguagesStore.getState().finish()).toBe(true)
    expect(useLanguagesStore.getState().ready).toBe(true)
  })

  /** 아무것도 안 고르고 마치면 계속 선택 화면에 남아야 한다 */
  it('아무것도 없으면 마칠 수 없다', () => {
    reset()
    expect(useLanguagesStore.getState().finish()).toBe(false)
    expect(useLanguagesStore.getState().ready).toBe(false)
  })

  it('목록에 없는 코드는 무시한다', () => {
    reset()
    useLanguagesStore.getState().toggle('xx' as never)
    expect(codes()).toEqual([])
  })
})

describe('계정의 언어를 채택한다', () => {
  /**
   * 배운 언어는 계정에 묶여 있다 — 폰에서 프랑스어를 추가하면 노트북에서도 보여야 한다.
   * 병합은 합집합이므로 이 기기에서 고르지 않은 언어도 함께 온다.
   */
  it('계정의 언어를 그대로 받는다', () => {
    reset()
    useLanguagesStore.getState().adopt(['en', 'fr', 'de'])
    expect(codes()).toEqual(['en', 'fr', 'de'])
  })

  /**
   * 새 기기에서 로그인하면 같은 선택을 다시 하지 않게 하는 것이 목적이다.
   */
  it('계정 언어를 받으면 온보딩은 끝난 것으로 본다', () => {
    reset()
    expect(useLanguagesStore.getState().ready).toBe(false)
    useLanguagesStore.getState().adopt(['en'])
    expect(useLanguagesStore.getState().ready).toBe(true)
  })

  it('목록에 없는 코드는 버린다 — 화이트리스트가 유일한 기준이다', () => {
    reset()
    useLanguagesStore.getState().adopt(['en', 'xx' as never])
    expect(codes()).toEqual(['en'])
  })

  it('빈 목록이면 온보딩을 되돌리지 않는다 — 아무것도 배우지 않은 계정일 수 있다', () => {
    reset()
    useLanguagesStore.getState().adopt(['en'])
    useLanguagesStore.getState().adopt([])
    expect(useLanguagesStore.getState().ready).toBe(true)
    expect(codes()).toEqual(['en'])
  })

  it('같은 목록이면 상태를 새로 만들지 않는다 — 세션 갱신마다 화면을 다시 그리지 않는다', () => {
    reset()
    useLanguagesStore.getState().adopt(['en', 'fr'])
    const before = useLanguagesStore.getState()
    useLanguagesStore.getState().adopt(['en', 'fr'])
    expect(useLanguagesStore.getState()).toBe(before)
  })

  /** 다른 기기에서 뺀 언어는 서버에서 지워지지 않는다 — 합집합 병합이므로 */
  it('기존 언어도 계정에 합쳐진 상태로 남는다', () => {
    reset()
    useLanguagesStore.getState().adopt(['en', 'fr'])
    useLanguagesStore.getState().adopt(['en', 'de'])
    // 병합은 서버에서 합집합으로 온다 — 호출자가 합쳐서 넘긴다
    expect(codes()).toEqual(['en', 'de'])
  })
})