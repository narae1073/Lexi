import type { WordStatus } from '../types'

/**
 * 상태 → 클래스 매핑 (PLAN.md §5.7).
 *
 * 아는 단어(known)는 기본 색 그대로 둔다 (plan.txt 4줄) — zinc-900 같은 값을 주면
 * 아직 표시하지 않은 단어의 검정과 색이 달라져 "기본 색"이라는 조건을 어긴다.
 *
 * 표시 안 한 단어(unmarked)는 본문색을 조금 옅게 해서, 본문을 훑을 때
 * 이미 아는 단어와 아직 볼 단어가 한눈에 갈리게 한다.
 * 옅은 정도는 설정의 --unmarked-dim 이 정한다 (index.css).
 */
const STATUS_CLASS: Record<WordStatus, string> = {
  known: '',
  unsure: 'text-status-unsure underline decoration-dotted decoration-1 underline-offset-4 bg-status-unsure-bg',
  unknown: 'text-status-unknown underline decoration-1 underline-offset-4 bg-status-unknown-bg',
}

const UNMARKED_CLASS = 'text-unmarked'

/**
 * 'unmarked' 는 상태가 아직 없는 단어를 뜻한다.
 * 상태가 없는 경우(undefined)와 같은 표시이므로 여기서 받아준다 —
 * 상태 바처럼 모르는 값을 반드시 만들어 내는 곳에서도 같은 규칙을 쓴다.
 */
export function statusClass(status: WordStatus | 'unmarked' | undefined): string {
  if (!status || status === 'unmarked') return UNMARKED_CLASS
  return STATUS_CLASS[status]
}

/**
 * 표시 점(●)의 색 — 게이지 설명·상태 바의 점.
 *
 * statusClass 를 그대로 쓰면 두 가지가 어긋난다.
 * - '아는' 은 클래스가 비어 본문색을 받는 규칙인데, 점은 muted 글자 안에 놓여
 *   muted 회색이 된다 — 막대(bg-ink, 본문색)와 다른 색으로 읽힌다.
 * - 밑줄·배경 클래스가 점에도 얹혀 ● 아래에 점선이 그어진다.
 *
 * 점은 막대와 같은 말을 해야 한다 — 같은 상태를 막대에서는 검게, 점에서는
 * 회색으로 그리면 설명이 막대를 배신한다.
 */
const STATUS_DOT_CLASS: Record<WordStatus | 'unmarked', string> = {
  known: 'text-ink',
  unsure: 'text-status-unsure',
  unknown: 'text-status-unknown',
  unmarked: 'text-unmarked',
}

export function statusDotClass(status: WordStatus | 'unmarked' | undefined): string {
  return STATUS_DOT_CLASS[status ?? 'unmarked']
}

/**
 * 상태 배지의 색 — 테두리 상자 안에 상태를 쓸 때 (퀴즈 끝난 화면의 before/after).
 *
 * statusClass 는 본문 낱말에 쓰는 것이라 밑줄이 붙는다. 배지에서는 밑줄이 글자를
 * 어지럽히므로 색과 배경만 가져온다. '아는' 은 색을 칠하지 않는 규칙 그대로다.
 */
const STATUS_PILL_CLASS: Record<WordStatus, string> = {
  known: 'border-line text-ink',
  unsure: 'border-status-unsure bg-status-unsure-bg text-status-unsure',
  unknown: 'border-status-unknown bg-status-unknown-bg text-status-unknown',
}

export function statusPillClass(status: WordStatus): string {
  return STATUS_PILL_CLASS[status]
}