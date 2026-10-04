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

export function statusClass(status: WordStatus | undefined): string {
  if (!status) return UNMARKED_CLASS
  return STATUS_CLASS[status]
}