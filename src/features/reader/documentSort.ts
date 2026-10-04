import type { Document } from '../../types'

/**
 * 문서 목록 정렬.
 *
 * '최근 본 시각' 이 전부 같은 값으로 stamped 되던 시기에는 '수정 순' 이 쓸모없었다.
 * 같은 순서로 매번 다르게 보이는 것보다, 알 수 있는 기준으로 정렬하는 편이 낫다.
 */
export const DOCUMENT_SORTS = ['recent', 'longest', 'created', 'alpha'] as const

export type DocumentSort = (typeof DOCUMENT_SORTS)[number]

export const DEFAULT_DOCUMENT_SORT: DocumentSort = 'recent'

export function isDocumentSort(value: unknown): value is DocumentSort {
  return (DOCUMENT_SORTS as readonly unknown[]).includes(value)
}

/** 정렬 키가 맞지 않으면 기본값으로 되돌린다 — 깨진 저장을 스스로 고쳐야 한다 */
export function documentSortOrDefault(value: unknown): DocumentSort {
  return isDocumentSort(value) ? value : DEFAULT_DOCUMENT_SORT
}

/** 목록 글자 수 — '글자가 많은 순' 의 기준 */
export function documentLength(doc: Document): number {
  return doc.rawText.trim().length
}

function byRecent(a: Document, b: Document): number {
  // 시각이 같으면 제목으로 갈린다 — 같은 값끼리는 순서가 달라져 화면이 출렁인다
  return b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title, 'en')
}

function byCreated(a: Document, b: Document): number {
  return b.createdAt.localeCompare(a.createdAt) || a.title.localeCompare(b.title, 'en')
}

function byLongest(a: Document, b: Document): number {
  return documentLength(b) - documentLength(a) || byRecent(a, b)
}

function byAlpha(a: Document, b: Document): number {
  return a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }) || byRecent(a, b)
}

const COMPARATORS: Record<DocumentSort, (a: Document, b: Document) => number> = {
  recent: byRecent,
  longest: byLongest,
  created: byCreated,
  alpha: byAlpha,
}

/**
 * 정렬한다. 원본 배열은 건드리지 않는다.
 *
 * 목록의 기준을 고르�� 수 있어야, 고른 기준이 실제 적용된다는 것도 보여 줘야 한다.
 */
export function sortDocuments(documents: Document[], sort: DocumentSort): Document[] {
  return [...documents].sort(COMPARATORS[documentSortOrDefault(sort)])
}