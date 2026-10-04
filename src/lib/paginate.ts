/**
 * 페이지 나누기 (PLAN.md Phase 7).
 *
 * 목록이 길어지면 화면이 그대로 늘어진다. 문서 본문과 단어장이 같은 규칙을
 * 쓰도록 계산만 here 에 두고, UI 는 Pagination 컴포넌트가 맡는다.
 */

export type Page<T> = {
  /** 현재 페이지에 담기는 항목 */
  items: T[]
  /** 1 부터 시작. 범위를 벗어나면 가장 가까운 페이지로 당겨진다 */
  page: number
  /** 전체 페이지 수. 비어 있어도 1 */
  pageCount: number
  total: number
  pageSize: number
  /** 화면에 보이는 순번 (1 부터). 비면 0 */
  from: number
  to: number
  hasPrev: boolean
  hasNext: boolean
}

/** 단어장 한 페이지에 보여줄 단어 수 선택지 */
export const PAGE_SIZES = [10, 20, 30, 40, 50] as const
export const DEFAULT_PAGE_SIZE = 20

/** 창이 좁아도 누를 수 있는 최소 크기 — 숫자 버튼이 좌우로 너무 많아지지 않게 */
export const MAX_PAGE_BUTTONS = 7

export function pageCountOf(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1
  return Math.max(1, Math.ceil(total / pageSize))
}

/**
 * 목록을 잘라 한 페이지를 돌려준다.
 *
 * 목록이 줄거나 필터를 바꿔 마지막 페이지가 사라지면 page 를 자동으로 당긴다 —
 * 그 상태를 화면에 반영하지 않으면 빈 페이지를 사용자에게 보여주게 된다.
 */
export function paginate<T>(items: T[], page: number, pageSize: number): Page<T> {
  const safeSize = Math.max(1, Math.floor(pageSize))
  const pageCount = pageCountOf(items.length, safeSize)

  const raw = Number.isFinite(page) ? Math.floor(page) : 1
  const safePage = Math.min(pageCount, Math.max(1, raw))

  const start = (safePage - 1) * safeSize
  const end = start + safeSize

  return {
    items: items.slice(start, end),
    page: safePage,
    pageCount,
    total: items.length,
    pageSize: safeSize,
    from: items.length === 0 ? 0 : start + 1,
    to: Math.min(end, items.length),
    hasPrev: safePage > 1,
    hasNext: safePage < pageCount,
  }
}

/**
 * 눌러야 할 페이지 번호들을 만든다.
 *
 * 1 쪽과 마지막 쪽은 항상 보여주고, 현재 페이지 주변만 드러낸다.
 * 가운데가 길어지면 … 로 접는다 — 100 쪽짜리 단어장에서 숫자 100 개를
 * 찍을 이유는 없다.
 *
 * max 는 '보이는 번호 버튼 수'다. … 는 누를 수 없으므로 세지 않는다.
 */
export function pageWindow(page: number, pageCount: number, max = MAX_PAGE_BUTTONS): (number | 'gap')[] {
  if (pageCount <= max) return Array.from({ length: pageCount }, (_, i) => i + 1)

  // 현재 페이지를 가운데 두고 양옆을 몇 개씩 보여줄지
  const side = Math.max(1, Math.floor((max - 3) / 2))
  let start = page - side
  let end = page + side

  if (start < 2) {
    start = 2
    end = max - 1
  }
  if (end > pageCount - 1) {
    end = pageCount - 1
    start = end - (max - 3)
  }

  const window: (number | 'gap')[] = [1]
  if (start > 2) window.push('gap')
  for (let i = start; i <= end; i++) window.push(i)
  if (end < pageCount - 1) window.push('gap')
  window.push(pageCount)
  return window
}
