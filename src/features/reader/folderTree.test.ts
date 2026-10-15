import { describe, expect, it } from 'vitest'

import type { Folder } from '../../types'
import { descendantsOf, pruneNestedTicks, visibleRoots } from './folderTree'

const folder = (over: Partial<Folder> & { id: string }): Folder => ({
  name: over.id,
  parentId: null,
  createdAt: `2026-01-01T00:00:00.000Z`,
  updatedAt: `2026-01-01T00:00:00.000Z`,
  ...over,
})

describe('중첩을 여는 순수 함수들', () => {
  it('자손을 전부 모은다 — 아들과 손자까지', () => {
    const all = [
      folder({ id: 'P' }),
      folder({ id: 'C', parentId: 'P' }),
      folder({ id: 'G', parentId: 'C' }),
      folder({ id: 'Q' }),
    ]
    const ids = descendantsOf(all, 'P').map((f) => f.id)
    expect(ids).toContain('C')
    expect(ids).toContain('G')
    expect(ids).not.toContain('P')
    expect(ids).not.toContain('Q')
  })

  it('뿌리로 보인다 — 직접 아이와 부모 잃은 폴더', () => {
    const tombstoned = folder({ id: 'T', deletedAt: '2026-02-01T00:00:00.000Z' })
    const all = [
      folder({ id: 'P' }),
      folder({ id: 'C', parentId: 'P' }),
      folder({ id: 'O', parentId: 'T' }),
      tombstoned,
    ]
    const ids = visibleRoots(all).map((f) => f.id)
    expect(ids).toContain('P')
    expect(ids).toContain('O')
    expect(ids).not.toContain('C')
  })

  it('겹친 체크는 부모만 남긴다 — 자식은 딸려 간다', () => {
    const all = [
      folder({ id: 'P' }),
      folder({ id: 'C', parentId: 'P' }),
      folder({ id: 'G', parentId: 'C' }),
    ]
    expect(pruneNestedTicks(all, ['P', 'C', 'G'])).toEqual(['P'])
  })
})
