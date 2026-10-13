import { describe, expect, it } from 'vitest'

import type { Document, Folder } from '../../types'
import { changedFolders, mergeDocuments, mergeFolders } from './sync'

const T = (n: number) => `2026-01-${String(n).padStart(2, '0')}T00:00:00.000Z`

const folder = (over: Partial<Folder> & { id: string }): Folder => ({
  name: over.id,
  parentId: null,
  createdAt: T(1),
  updatedAt: T(1),
  ...over,
})

const document = (over: Partial<Document> & { id: string }): Document => ({
  title: over.id,
  languageCode: 'en',
  rawText: 'x',
  createdAt: T(1),
  updatedAt: T(1),
  ...over,
})

describe('mergeFolders', () => {
  it('늦게 고친 쪽이 이긴다 — 이름 바꾸기가 서버 것을 물러낸다', () => {
    const local = [folder({ id: 'f1', name: 'New', updatedAt: T(2) })]
    const remote = [folder({ id: 'f1', name: 'Old', updatedAt: T(3) })]
    expect(mergeFolders(local, remote)[0].name).toBe('Old')
    expect(mergeFolders(remote, local)[0].name).toBe('Old')
  })

  it('늦은 인장으로 톰스톤이 이긴다 — 지운 폴더가 되살아나지 않는다', () => {
    const local = [folder({ id: 'f1', updatedAt: T(3), deletedAt: T(3) })]
    const remote = [folder({ id: 'f1', updatedAt: T(2) })]
    expect(mergeFolders(local, remote)[0].deletedAt).toBe(T(3))
  })

  it('인장이 같은데 지움·고침이 부딪히면 지움을 믿는다 — 되살리는 실수보다 조용한 쪽이다', () => {
    const local = [folder({ id: 'f1', updatedAt: T(3), deletedAt: T(3) })]
    const remote = [folder({ id: 'f1', updatedAt: T(3), name: 'Renamed' })]
    expect(mergeFolders(local, remote)[0].deletedAt).toBe(T(3))
  })

  it('두 기기가 만든 폴더가 합쳐진다', () => {
    const local = [folder({ id: 'f1' })]
    const remote = [folder({ id: 'f2' })]
    expect(mergeFolders(local, remote).map((f) => f.id).sort()).toEqual(['f1', 'f2'])
  })

  describe('changedFolders', () => {
    it('서버에 없는 폴더는 보낸다', () => {
      const merged = [folder({ id: 'f1' })]
      expect(changedFolders(merged, [])).toEqual(merged)
    })

    it('같으면 보내지 않는다 — 이 지점이 조용해야 할 곳이다', () => {
      const f = folder({ id: 'f1' })
      expect(changedFolders([f], [f])).toEqual([])
    })

    it('이름·부모·톰스톤이 달라졌으면 보낸다', () => {
      const f = folder({ id: 'f1' })
      expect(changedFolders([f], [{ ...f, name: 'Other' }])).toEqual([f])
      expect(changedFolders([f], [{ ...f, parentId: 'p1' }])).toEqual([f])
      expect(changedFolders([f], [{ ...f, deletedAt: T(2) }])).toEqual([f])
    })

    it('이 기기에서 더 늦게 고친 것만 보낸다 — 인장은 클라이언트 것을 믿는다', () => {
      const f = folder({ id: 'f1', updatedAt: T(3) })
      expect(changedFolders([f], [folder({ id: 'f1', updatedAt: T(2) })])).toEqual([f])
      expect(changedFolders([folder({ id: 'f1', updatedAt: T(2) })], [f])).toEqual([])
    })
  })

  describe('mergeDocuments — 폴더 인장', () => {
    /**
     * 문서 내용은 마지막으로 열은 쪽이 이긴다. 폴더는 **언제 옮겼는가**로
     * 따로 이긴다 — 오래 전에 열린 문서를 방금 옮긴 기록이 무시되면 안 된다.
     */
    it('옛 문서를 방금 옮긴 기록이 이긴다', () => {
      const local = [document({ id: 'd1', folderId: 'f1', folderUpdatedAt: T(4) })]
      const remote = [document({ id: 'd1', updatedAt: T(9) })]
      // 서버에 더 늦게 열린 기록이 있어도, 폴더 인장이 뒤집지 않는다
      expect(mergeDocuments(local, remote)[0].folderId).toBe('f1')
    })

    it('늦게 옮긴 쪽이 이긴다 — 다른 기기의 옮김도 온다', () => {
      const local = [document({ id: 'd1', folderId: 'f1', folderUpdatedAt: T(4) })]
      const remote = [document({ id: 'd1', folderId: 'f2', folderUpdatedAt: T(5) })]
      expect(mergeDocuments(local, remote)[0].folderId).toBe('f2')
    })

    it('폴더에서 없앤 것도 인장으로 이긴다 — NULL 로 돌아간다', () => {
      const local = [document({ id: 'd1', folderId: null, folderUpdatedAt: T(6) })]
      const remote = [document({ id: 'd1', folderId: 'f1', folderUpdatedAt: T(5) })]
      expect(mergeDocuments(local, remote)[0].folderId).toBeNull()
    })

    it('인장이 없던 옛 기록과는 폴더가 있는 쪽이 이긴다', () => {
      const local = [document({ id: 'd1', folderId: 'f1', folderUpdatedAt: T(4) })]
      const remote = [document({ id: 'd1', folderId: 'f0' })]
      expect(mergeDocuments(local, remote)[0].folderId).toBe('f1')
    })

    it('열기가 옮김보다 늦어도 내용의 승자는 열리기다', () => {
      const local = [document({ id: 'd1', title: 'Local', updatedAt: T(2) })]
      const remote = [document({ id: 'd1', title: 'Remote', updatedAt: T(9) })]
      expect(mergeDocuments(local, remote)[0].title).toBe('Remote')
    })

    it('폴더 문을 옮긴쪽이 이겼을 때, 열기의 승자와 다르면 나머지는 열기의 것을 따른다', () => {
      // 폴더는 A, 내용은 B — 두 인장은 따로 논다
      const local = [document({ id: 'd1', title: '로컬', updatedAt: T(2), folderId: 'f1', folderUpdatedAt: T(9) })]
      const remote = [document({ id: 'd1', title: '서버', updatedAt: T(9), folderId: null })]
      const merged = mergeDocuments(local, remote)[0]
      expect(merged.title).toBe('서버')
      expect(merged.folderId).toBe('f1')
    })
  })
})
