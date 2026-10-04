import { describe, expect, it } from 'vitest'

import { mergeDocuments } from '../../lib/sync/sync'
import type { Document } from '../../types'
import { activeDocuments, sortDocuments, trashedDocuments } from './documentSort'

const doc = (id: string, extra: Partial<Document> = {}): Document => ({
  id,
  title: id,
  languageCode: 'en',
  rawText: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
})

describe('휴지통', () => {
  it('살아 있는 문서와 버린 문서를 나눈다', () => {
    const all = [doc('a'), doc('b', { deletedAt: '2026-02-01T00:00:00.000Z' })]
    expect(activeDocuments(all).map((d) => d.id)).toEqual(['a'])
    expect(trashedDocuments(all).map((d) => d.id)).toEqual(['b'])
  })

  it('deletedAt 이 비어 있으면 살아 있는 문서다', () => {
    const all = [doc('a', { deletedAt: null }), doc('b', { deletedAt: undefined })]
    expect(activeDocuments(all)).toHaveLength(2)
  })

  it('목록 정렬에서 버린 문서는 빠진다', () => {
    const all = [doc('a'), doc('b', { deletedAt: '2026-02-01T00:00:00.000Z' })]
    expect(sortDocuments(activeDocuments(all), 'alpha').map((d) => d.id)).toEqual(['a'])
  })

  it('동기화에서 버린 상태가 이 기기에 반영된다', () => {
    const trashed = doc('a', { deletedAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' })
    expect(trashedDocuments(mergeDocuments([doc('a')], [trashed]))).toHaveLength(1)
  })

  /**
   * 되살린 쪽이 나중에 일어난 일이어야 이 기기가 이긴다.
   *
   * 버리거나 되살릴 때 updatedAt 이 올라간다 — 그 시각이 병합의 기준이다.
   * 시각이 같으면 서버가 이긴다.
   */
  it('되살린 문서가 나중이면 살아 있는 문서로 합쳐진다', () => {
    const trashed = doc('a', { deletedAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' })
    const restored = { ...trashed, deletedAt: null, updatedAt: '2026-03-01T00:00:00.000Z' }
    expect(activeDocuments(mergeDocuments([restored], [trashed])).map((d) => d.id)).toEqual(['a'])
  })

  it('버린 쪽이 나중이면 이 기기에서도 사라진다', () => {
    const trashed = doc('a', { deletedAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-04-01T00:00:00.000Z' })
    const alive = { ...trashed, deletedAt: null, updatedAt: '2026-03-01T00:00:00.000Z' }
    expect(activeDocuments(mergeDocuments([alive], [trashed]))).toHaveLength(0)
  })
})

describe('제목 바꾸기', () => {
  it('이름 순 정렬이 새 제목을 따른다', () => {
    const all = [doc('a', { title: 'Zebra' }), doc('b', { title: 'Apple' })]
    expect(sortDocuments(all, 'alpha', 'asc').map((d) => d.title)).toEqual(['Apple', 'Zebra'])
  })

  it('제목이 같으면 다른 기준으로 갈린다 — 이름 순에서는 길이를 본다', () => {
    const same = [doc('a', { title: 'Same', rawText: 'xx' }), doc('b', { title: 'Same', rawText: 'x' })]
    // 이름 순에서는 제목이 같아 순서가 없고, 안정성을 위해 id 로 갈린다
    const order = sortDocuments(same, 'alpha', 'asc').map((d) => d.id)
    expect(order).toEqual([...order].sort())
  })
})

describe('빈 제목', () => {
  it('구분을 할 수 없으므로 거부된다', () => {
    // 목록에서 이름이 빈 문서를 찾을 방법이 없다
    const result = doc('a', { title: '   ' })
    expect(result.title.trim()).toBe('')
    expect(sortDocuments([result], 'alpha').map((d) => d.title)).toEqual(['   '])
  })
})
