import { describe, expect, it } from 'vitest'

import { stripElision, stripFrenchElision } from './elision'

/**
 * 프랑스어 축약 (élision).
 *
 * 짧은 기능어가 모음 앞에서 끝 음절을 잃는다 — de + été → d'été.
 * 배우는 사람에게 d'été 는 'été' 다. 사전에도 'd'été' 는 없다.
 */
describe('프랑스어 축약 접기', () => {
  it('앞이 d\' 면 접는다', () => {
    expect(stripFrenchElision("d'été")).toBe('été')
    expect(stripFrenchElision("d'eau")).toBe('eau')
    expect(stripFrenchElision("d'affaires")).toBe('affaires')
    expect(stripFrenchElision("d'accord")).toBe('accord')
  })

  it('다른 기능어도 접는다 — 앞부분은 사전 항목이 아니다', () => {
    expect(stripFrenchElision("l'école")).toBe('école')
    expect(stripFrenchElision("n'est")).toBe('est')
    expect(stripFrenchElision("c'est")).toBe('est')
    expect(stripFrenchElision("j'ai")).toBe('ai')
    expect(stripFrenchElision("m'en")).toBe('en')
    expect(stripFrenchElision("t'y")).toBe('y')
    expect(stripFrenchElision("s'appelle")).toBe('appelle')
  })

  /**
   * 고유명사는 접지 않는다.
   *
   * 프랑스어는 아포스트로피 뒤의 고유명사를 대문자로 쓴다 — d'Artagnan, l'École.
   * 접으면 이름이 망가진다. 그리고 사람 이름을 두 가지 다른 단어로 세게 된다.
   */
  it('아포스트로피 뒤가 대문자면 고유명사다 — 접지 않는다', () => {
    expect(stripFrenchElision("d'Artagnan")).toBeNull()
    expect(stripFrenchElision("l'École")).toBeNull()
    expect(stripFrenchElision("d'Été")).toBeNull()
  })

  /** 표기 규칙 경로: 소문자로 접은 뒤 대문자 판정을 다시 거치지 않는다 */
  it('소문자로 접으면 고유명사 판정을 벗어난다 — 그래서 판정 전에 접지 않는다', () => {
    // 위험을 보여 주는 확인이다. 소문자로 먼저 접으면 대문자 가드를 통과한다.
    expect(stripElision("d'Artagnan".toLowerCase(), 'fr')).toBe('artagnan')
    // 그래서 고유명사 표기는 처음부터 손대지 않는다
    expect(stripFrenchElision("d'Artagnan")).toBeNull()
  })

  it('남은 쪽에 또 아포스트로피가 있으면 건드리지 않는다', () => {
    expect(stripFrenchElision("d'aujourd'hui")).toBeNull()
    expect(stripFrenchElision("lRock'n'Roll")).toBeNull()
  })

  /** 아포스트로피 뒤에 글자가 와야 축약이다 — 기호가 오면 접지 않는다 */
  it('아포스트로피 뒤에 글자가 없으면 접지 않는다', () => {
    expect(stripFrenchElision("d!'")).toBeNull()
    expect(stripFrenchElision("d'")).toBeNull()
    expect(stripFrenchElision("l'")).toBeNull()
  })

  /**
   * qu' 은 넣지 않았다.
   *
   * qu'il 에서 배울 단어는 il 이 아니라 qui 다. 어느 쪽으로 접어도 뜻이 어긋나고,
   * 접지 않으면 최소한 원형 그대로 사전 조회가 된다.
   */
  it('qu\' 은 접지 않는다 — 어느 쪽으로 접어도 틀린다', () => {
    expect(stripFrenchElision("qu'il")).toBeNull()
    expect(stripFrenchElision("qu'est")).toBeNull()
  })

  /** 어두운 위치의 축약은 아니다 — Reims 나 Paris 같은 지명 */
  it('어두운 글자가 아니라면 접지 않는다', () => {
    expect(stripFrenchElision("d")).toBeNull()
    expect(stripFrenchElision("de")).toBeNull()
    expect(stripFrenchElision("des")).toBeNull()
    expect(stripFrenchElision("dont")).toBeNull()
  })

  /**
   * 한 글자여도 접는다 — t'y 는 te + y 다.
   *
   * 어설픈 접착을 막으려고 길이를 재면 진짜 축약까지 놓친다.
   */
  it('한 글자가 남아도 접는다', () => {
    expect(stripFrenchElision("t'y")).toBe('y')
    expect(stripFrenchElision("m'a")).toBe('a')
  })

  it('아포스트로피 세 종류를 모두 받아들인다', () => {
    expect(stripFrenchElision("d'été")).toBe('été')
    expect(stripFrenchElision('d’été')).toBe('été')
    expect(stripFrenchElision('dʼété')).toBe('été')
  })

  it('프랑스어가 아니면 건드리지 않는다', () => {
    expect(stripElision("d'été", 'en')).toBeNull()
    expect(stripElision("d'été", 'de')).toBeNull()
    expect(stripElision("d'été")).toBeNull()
  })
})