/**
 * 문장 선택 진단 기록.
 *
 * 왜 이게 필요한가: 터치 기기에서의 텍스트 선택은 브라우저의 영역이고, 나는
 * 기기에서 재현할 수 없다. touchend 를 기다리다 selectionchange 로 바꾸고
 * 두 번이나 고쳤지만 폰에서는 계속 안 떴다. 그때마다 다른 이유를 가정했고
 * 모두 틀렸다.
 *
 * 이제 추측을 멈춘다. 기기에서 무슨 일이 일어나는지 그대로 보여 준다.
 * `?debug=select` 를 붙이면 화면에 패널이 뜬다 — 폰에서는 개발자 도구를
 * 열기 어려우므로 화면에 떠 있어야 눈으로 읽어 옮길 수 있다.
 */

export type SelectionTrace = {
  /** selectionchange 가 몇 번 울렸다 */
  events: number
  /** 마지막 신호로부터 지난 시간 */
  at: string
  isCollapsed: boolean | null
  rangeCount: number
  /** 브라우저가 selection 을 어떤 종류로 보고하는지 — OS 선택이면 'None' 이기도 하다 */
  selectionType: string | null
  startInContainer: boolean
  endInContainer: boolean
  ancestorInContainer: boolean
  /** 원문 기준 오프셋 */
  start: number | null
  end: number | null
  /** 찾은 문장 번호 */
  sentences: number[]
  /** 마지막 판정 */
  note: string
}

const MAX = 40

let events = 0
let last: SelectionTrace | null = null
const history: SelectionTrace[] = []

export function enabled(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('debug') === 'select'
}

export function countEvent(): void {
  events += 1
}

/** 판정 결과를 남긴다. 패널이 꺼져 있으면 문자열만 만든다 — 부가 비용을 막는다 */
export function record(trace: SelectionTrace): void {
  last = { ...trace, events, at: new Date().toLocaleTimeString() }
  if (!enabled()) return
  history.push(last)
  if (history.length > MAX) history.shift()
}

export function latest(): SelectionTrace | null {
  return last
}

export function lines(): string[] {
  if (last === null) return ['선택 신호를 아직 못 받았습니다']
  const t = last
  return [
    `신호 ${t.events}회 · ${t.at}`,
    `collapsed=${String(t.isCollapsed)} ranges=${t.rangeCount} type=${t.selectionType ?? '-'}`,
    `본문 안: 시작=${yn(t.startInContainer)} 끝=${yn(t.endInContainer)} 조상=${yn(t.ancestorInContainer)}`,
    `오프셋 ${t.start ?? '-'} ~ ${t.end ?? '-'}`,
    `문장 [${t.sentences.join(',')}]`,
    `판정: ${t.note}`,
  ]
}

export function historyLines(): string[] {
  return history.slice(-8).map((h) => `${h.at} ${h.note} collapsed=${String(h.isCollapsed)}`)
}

function yn(value: boolean): string {
  return value ? 'Y' : 'n'
}

export function reset(): void {
  events = 0
  last = null
  history.length = 0
}
