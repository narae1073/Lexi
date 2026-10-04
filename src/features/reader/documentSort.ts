import type { Document } from '../../types'

/**
 * 문서 목록 정렬.
 *
 * '최근 본 시각' 이 전부 같은 값으로 stamped 되던 시기에는 '수정 순' 이 쓸모없었다.
 * 같은 순서로 매번 다르게 보이는 것보다, 알 수 있는 기준으로 정렬하는 편이 낫다.
 */
export const DOCUMENT_SORTS = ['recent', 'longest', 'created', 'alpha'] as const

export type DocumentSort = (typeof DOCUMENT_SORTS)[number]

/**
 * 기준마다 '그대로'가 뜻하는 방향이 다르다.
 *
 * 최근 본 순은 최신이 먼저가 자연스럽지만, 이름 순은 A→Z 가 자연스럽다.
 * 그래서 방향은 전역 하나가 아니라 기준마다 들고 있다 — 알파벳 순을 뒤집은 다음
 * 최근 본 순으로 갔다 돌아오면 각자의 방향이 그대로다.
 */
export type SortDirection = 'asc' | 'desc'

export const DEFAULT_SORT_DIRECTION: Record<DocumentSort, SortDirection> = {
  recent: 'desc',
  longest: 'desc',
  created: 'desc',
  alpha: 'asc',
}

export const DEFAULT_DOCUMENT_SORT: DocumentSort = 'recent'

export function isDocumentSort(value: unknown): value is DocumentSort {
  return (DOCUMENT_SORTS as readonly unknown[]).includes(value)
}

export function isSortDirection(value: unknown): value is SortDirection {
  return value === 'asc' || value === 'desc'
}

/** 정렬 키가 맞지 않으면 기본값으로 되돌린다 — 깨진 저장을 스스로 고쳐야 한다 */
export function documentSortOrDefault(value: unknown): DocumentSort {
  return isDocumentSort(value) ? value : DEFAULT_DOCUMENT_SORT
}

export function directionOrDefault(sort: DocumentSort, value: unknown): SortDirection {
  return isSortDirection(value) ? value : DEFAULT_SORT_DIRECTION[sort]
}

export function flipDirection(direction: SortDirection): SortDirection {
  return direction === 'asc' ? 'desc' : 'asc'
}

/** 목록 글자 수 — '글자가 많은 순' 의 기준 */
export function documentLength(doc: Document): number {
  return doc.rawText.trim().length
}

/**
 * 주 키 비교기 — 방향을 적용할 대상이다.
 */
const PRIMARY: Record<DocumentSort, (a: Document, b: Document) => number> = {
  recent: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
  created: (a, b) => a.createdAt.localeCompare(b.createdAt),
  longest: (a, b) => documentLength(a) - documentLength(b),
  alpha: (a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }),
}

/**
 * 동률일 때의 비교기 — 항상 오름차순.
 *
 * 방향을 뒤집어도 이건 뒤집지 않는다. 같은 값끼리의 순서가 입력에 따라 달라지면
 * 화면이 출렁이고, '정렬했는데 왜 순서가 바뀌지' 하는 이유가 생긴다.
 */
function tieBreak(a: Document, b: Document): number {
  return a.title.localeCompare(b.title, 'en', { sensitivity: 'base' })
}

/**
 * 정렬한다. 원본 배열은 건드리지 않는다.
 *
 * 목록의 기준을 고를 수 있어야, 고른 기준이 실제 적용된다는 것도 보여 줘야 한다.
 */
export function sortDocuments(
  documents: Document[],
  sort: DocumentSort,
  direction: SortDirection = DEFAULT_SORT_DIRECTION[documentSortOrDefault(sort)],
): Document[] {
  const primary = PRIMARY[documentSortOrDefault(sort)]
  const ordered =
    direction === 'asc'
      ? (a: Document, b: Document) => primary(a, b) || tieBreak(a, b)
      : // 주 키에만 방향을 준다 — 동률은 언제나 제목 오름차순
        (a: Document, b: Document) => -primary(a, b) || tieBreak(a, b)
  return [...documents].sort(ordered)
}
/** 살아 있는 문서 — 휴지통에 있는 것은 제외한다 */
export function activeDocuments(documents: Document[]): Document[] {
  return documents.filter((doc) => !doc.deletedAt)
}

/** 휴지통에 있는 문서 */
export function trashedDocuments(documents: Document[]): Document[] {
  return documents.filter((doc) => Boolean(doc.deletedAt))
}
