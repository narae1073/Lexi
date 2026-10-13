import { create } from 'zustand'

import { STORES, idbGetAll, idbPut } from '../../lib/storage/localDb'
import { liveFolders } from '../../features/reader/folderTree'
import { useDocumentsStore } from './documents'
import type { Folder } from '../../types'

function now(): string {
  return new Date().toISOString()
}

type FoldersState = {
  /** 살아 있는 폴더만 — 톰스톤은 저장소에 남아 다른 기기와 병합에서 쓰인다 */
  folders: Folder[]
  loading: boolean
  /**
   * IndexedDB 읽기가 한 번이라도 끝났는가 — 문서 목록의 ready 와 같은 이유다.
   * 없으면 '폴더 없다' 고 판단해 화면이 깜빡인다.
   */
  ready: boolean
  load: () => Promise<void>
  /** 새 폴더를 만든다. 빈 이름은 받지 않는다 — 제목 없는 폴더는 길을 잃는다 */
  create: (name: string, parentId?: string | null) => Promise<Folder | null>
  rename: (id: string, name: string) => Promise<boolean>
  /**
   * 폴더를 지운다 — 바로 지우지 않고 톰스톤을 남긴다 (문서 휴지통과 같은 이유다).
   *
   * 안에 있던 것들은 사라지지 않는다. 하위 폴더와 담긴 문서는 지워진 폴더의
   * 부모로 옮겨 간다 — 뿌리 폴더를 지우면 폴더 없는 상태로 돌아간다.
   * 문서 학습 기록은 문서에 붙어 있으므로 아무 일도 일어나지 않는다.
   */
  deleteFolder: (id: string) => Promise<void>
}

/**
 * 두 목록이 같은 내용인지 — 같은데 갈아끼우지 않기 위한 판단.
 *
 * 동기화가 자주 돌고, 새 목록 하나만 만들어져도 칩 줄 전체가 다시 그려진다.
 * 내용이 같으면 그대로 둔다 (문서 목록의 sameDocuments 와 같은 규칙이다).
 */
export function sameFolders(a: Folder[], b: Folder[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((folder, i) => {
    const other = b[i]
    return (
      folder.id === other.id &&
      folder.name === other.name &&
      (folder.parentId ?? null) === (other.parentId ?? null) &&
      folder.createdAt === other.createdAt &&
      folder.updatedAt === other.updatedAt
    )
  })
}

export const useFoldersStore = create<FoldersState>((set, get) => ({
  folders: [],
  loading: false,
  ready: false,

  /**
   * 저장소의 폴더를 읽는다. 톰스톤은 화면에 없다 — 되살릴 곳은 만들지 않았다.
   *
   * 순서는 만든 순이다 — 폴더는 사람이 골라 담는 자리일 뿐, 최신성을 따지는
   * 자리가 아니다. 만든 순서는 규칙이 바뀌지 않는다.
   */
  load: async () => {
    if (!get().ready) set({ loading: true })

    const all = await idbGetAll<Folder>(STORES.folders)
    const live = liveFolders(all).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    set((s) => (sameFolders(s.folders, live) ? { loading: false, ready: true } : { folders: live, loading: false, ready: true }))
  },

  create: async (name, parentId = null) => {
    const trimmed = name.trim()
    if (!trimmed) return null

    const timestamp = now()
    const folder: Folder = {
      id: crypto.randomUUID(),
      name: trimmed,
      parentId,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await idbPut(STORES.folders, folder).catch((error) => {
      console.error('폴더 저장 실패', error)
    })
    set((s) => ({ folders: [...s.folders, folder] }))
    return folder
  },

  rename: async (id, name) => {
    const trimmed = name.trim()
    // 빈 이름 → 폴더가 목록에서 사라지니 받지 않는다
    if (!trimmed) return false
    const folder = get().folders.find((f) => f.id === id)
    if (!folder || folder.name === trimmed) return false

    const next: Folder = { ...folder, name: trimmed, updatedAt: now() }
    set((s) => ({ folders: s.folders.map((f) => (f.id === id ? next : f)) }))
    await idbPut(STORES.folders, next).catch((error) => {
      console.error('폴더 이름 저장 실패', error)
    })
    return true
  },

  deleteFolder: async (id) => {
    const folder = get().folders.find((f) => f.id === id)
    if (!folder) return

    const timestamp = now()
    const tombstone: Folder = { ...folder, deletedAt: timestamp, updatedAt: timestamp }
    await idbPut(STORES.folders, tombstone).catch((error) => {
      console.error('폴더 지우기 실패', error)
    })

    // 하위 폴더를 부모로 옮긴다 — 새 부모가 루트면 parentId 는 NULL 이 된다
    const children = get().folders.filter((f) => f.parentId === id)
    for (const child of children) {
      const moved: Folder = { ...child, parentId: folder.parentId, updatedAt: timestamp }
      await idbPut(STORES.folders, moved).catch((error) => {
        console.error('폴더 옮기기 실패', error)
      })
    }

    // 담긴 문서도 부모로 옮긴다 — 문서 저장소가 같은 말을 하게 한다
    // (moveToFolder 는 folder_updated_at 인장을 찍어 병합에 실어 보낸다)
    const documents = useDocumentsStore.getState().documents
    const memberIds = documents
      .filter((doc) => doc.folderId === id)
      .map((doc) => doc.id)
    await useDocumentsStore.getState().moveToFolder(memberIds, folder.parentId)

    // 화면에서 먼저 뺀다 — 저장은 이미 따라 잡는다 (문서 purge 의 규칙과 같다)
    set((s) => ({
      folders: s.folders
        .filter((f) => f.id !== id)
        .map((f) => {
          const child = children.find((c) => c.id === f.id)
          return child ? { ...child, parentId: folder.parentId, updatedAt: timestamp } : f
        }),
    }))
  },
}))
