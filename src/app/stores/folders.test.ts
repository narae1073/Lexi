import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'

import { STORES, idbDelete, idbGet, idbGetAll } from '../../lib/storage/localDb'
import type { Document, Folder } from '../../types'
import { useDocumentsStore } from './documents'
import { sameFolders, useFoldersStore } from './folders'

const folder = (over: Partial<Folder> & { id: string; day?: number }): Folder => ({
  name: over.id,
  parentId: null,
  createdAt: `2026-01-0${over.day ?? 1}T00:00:00.000Z`,
  updatedAt: `2026-01-0${over.day ?? 1}T00:00:00.000Z`,
  ...over,
})

const document = (over: Partial<Document> & { id: string }): Document => ({
  title: over.id,
  languageCode: 'en',
  rawText: 'x',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

/** 어디에도 안 쓰였지만, 향후 폴더 순서 시험에서 쓴다 — 지우지 않고 두면 다시 쓴다 */
void document

/** 같은 파일 안의 모든 시험은 같은 저장소를 계속 쓴다 — 매번 비운다 */
beforeEach(async () => {
  for (const store of [STORES.folders, STORES.documents]) {
    const rows = await idbGetAll<Record<string, unknown>>(store)
    for (const row of rows) {
      await idbDelete(store, row.id as IDBValidKey)
    }
  }
  useFoldersStore.setState({ folders: [], loading: false, ready: false })
  useDocumentsStore.setState({ documents: [], loading: false, ready: true })
  await useFoldersStore.getState().load()
  await useDocumentsStore.getState().load()
})

describe('folders store', () => {
  it('만든다 — 저장소에 남고 목록에 온다', async () => {
    const created = await useFoldersStore.getState().create('Reading', null)
    expect(created?.name).toBe('Reading')

    const stored = await idbGetAll<Folder>(STORES.folders)
    expect(stored.some((f) => f.name === 'Reading')).toBe(true)

    await useFoldersStore.getState().load()
    expect(useFoldersStore.getState().folders.some((f) => f.id === created?.id)).toBe(true)
  })

  it('빈 이름은 받지 않는다 — 제목 없는 폴더는 길을 잃는다', async () => {
    expect(await useFoldersStore.getState().create('   ')).toBeNull()
    expect(useFoldersStore.getState().folders).toHaveLength(0)
  })

  it('이름을 바꾼다 — 빈 이름은 거절이다', async () => {
    const created = await useFoldersStore.getState().create('Reading')
    const changed = await useFoldersStore.getState().rename(created!.id, 'Books')
    expect(changed).toBe(true)
    expect(useFoldersStore.getState().folders[0].name).toBe('Books')

    expect(await useFoldersStore.getState().rename(created!.id, '   ')).toBe(false)
    expect(useFoldersStore.getState().folders[0].name).toBe('Books')
  })

  it('지우면 톰스톤이 남는다 — 화면에서는 사라진다', async () => {
    const created = await useFoldersStore.getState().create('Reading')
    await useFoldersStore.getState().deleteFolder(created!.id)

    expect(useFoldersStore.getState().folders).toHaveLength(0)
    // 저장소에는 톰스톤이 있어 병합에서 '지움'이 전파된다
    const stored = await idbGetAll<Folder>(STORES.folders)
    expect(stored.some((f) => f.id === created!.id && f.deletedAt)).toBe(true)
  })

  /**
   * 폴더를 지우면 담긴 문서는 사라지지 않는다 — 지워진 폴더의 부모로 옮겨 간다.
   * 뿌리 폴더를 지우면 폴더 없는 상태로 돌아간다.
   */
  it('지운 폴더의 문서와 하위 폴더는 부모로 옮겨 간다', async () => {
    const parent = await useFoldersStore.getState().create('Books')
    const child = await useFoldersStore.getState().create('Novels', parent!.id)

    await useDocumentsStore.getState().create({
      title: 'Haus',
      languageCode: 'de',
      rawText: 'Das Haus ist groß.',
      fallbackTitle: 'Untitled',
    })
    const doc = useDocumentsStore.getState().documents[0]
    await useDocumentsStore.getState().moveToFolder([doc.id], child!.id)
    await useDocumentsStore.getState().load()

    // 뿌리 폴더를 지운다 — 안의 하위 폴더는 뿌리로 올라오고, 그 안의 문서는
    // 그 폴더에 그대로 담겨 있었다 (문서는 폴더의 아들이 아니라 하위 폴더의 아이다)
    await useFoldersStore.getState().deleteFolder(parent!.id)
    await useDocumentsStore.getState().load()

    expect(
      useFoldersStore.getState().folders.find((f) => f.id === child!.id)?.parentId,
    ).toBeNull()
    expect(
      useDocumentsStore.getState().documents.find((d) => d.id === doc.id)?.folderId,
    ).toBe(child!.id)

    /** 하위 폴더를 지우면 담긴 문서는 뿌리로 돌아온다 */
    await useFoldersStore.getState().deleteFolder(child!.id)
    await useDocumentsStore.getState().load()
    expect(
      useDocumentsStore.getState().documents.find((d) => d.id === doc.id)?.folderId,
    ).toBeNull()
  })

  it('지워진 폴더 안의 문서도 같이 옮겨 간다', async () => {
    const parent = await useFoldersStore.getState().create('Books')
    const child = await useFoldersStore.getState().create('Novels', parent!.id)

    await useDocumentsStore.getState().create({
      title: 'Haus',
      languageCode: 'de',
      rawText: 'Das Haus ist groß.',
      fallbackTitle: 'Untitled',
    })
    const doc = useDocumentsStore.getState().documents[0]
    await useDocumentsStore.getState().moveToFolder([doc.id], child!.id)
    // 문서를 먼저 휴지통에 버린 뒤 폴더를 지운다 — 버린 문서의 폴더 기록도 정리된다
    await useDocumentsStore.getState().trash(doc.id)
    await useFoldersStore.getState().deleteFolder(child!.id)

    const stored = await idbGet<Document>(STORES.documents, doc.id)
    expect(stored?.folderId).toBe(parent!.id)
  })
})

describe('documents moveToFolder', () => {
  it('폴더로 옮긴다 — 인장을 찍는다', async () => {
    await useFoldersStore.getState().create('Books')
    const folder = useFoldersStore.getState().folders[0]
    await useDocumentsStore.getState().create({
      title: 'Haus',
      languageCode: 'de',
      rawText: 'Das Haus ist groß.',
      fallbackTitle: 'Untitled',
    })
    const doc = useDocumentsStore.getState().documents[0]
    const openedAt = doc.updatedAt

    await useDocumentsStore.getState().moveToFolder([doc.id], folder.id)

    const moved = useDocumentsStore.getState().documents.find((d) => d.id === doc.id)
    // 열람 시각은 그대로다 — 폴더로 옮기는 일이 '마지막으로 본 시각' 을 찍으면 안 된다
    expect(moved?.updatedAt).toBe(openedAt)
    expect(moved?.folderId).toBe(folder.id)
    expect(moved?.folderUpdatedAt).toBeTruthy()

    const stored = await idbGet<Document>(STORES.documents, doc.id)
    expect(stored?.folderId).toBe(folder.id)
  })

  it('폴더에 없애는 것도 같은 길이다 (null)', async () => {
    await useFoldersStore.getState().create('Books')
    const folder = useFoldersStore.getState().folders[0]
    await useDocumentsStore.getState().create({
      title: 'Haus',
      languageCode: 'de',
      rawText: 'Das Haus ist groß.',
      fallbackTitle: 'Untitled',
    })
    const doc = useDocumentsStore.getState().documents[0]
    await useDocumentsStore.getState().moveToFolder([doc.id], folder.id)
    await useDocumentsStore.getState().moveToFolder([doc.id], null)

    expect(
      useDocumentsStore.getState().documents.find((d) => d.id === doc.id)?.folderId,
    ).toBeNull()
  })

  /** 골라 담아 여러 장을 옮기는 길(Phase 3)과 같은 말이다 */
  it('여러 장을 한 번에 옮긴다', async () => {
    await useFoldersStore.getState().create('Books')
    const folder = useFoldersStore.getState().folders[0]
    const store = useDocumentsStore.getState()
    await store.create({
      title: 'A',
      languageCode: 'en',
      rawText: 'One two.',
      fallbackTitle: 'Untitled',
    })
    await store.create({
      title: 'B',
      languageCode: 'en',
      rawText: 'Three four.',
      fallbackTitle: 'Untitled',
    })
    const ids = useDocumentsStore.getState().documents.map((d) => d.id)

    await useDocumentsStore.getState().moveToFolder(ids, folder.id)
    expect(
      useDocumentsStore.getState().documents.every((d) => d.folderId === folder.id),
    ).toBe(true)
  })

  it('이미 있는 폴더로 다시 옮기면 아무 일도 일어나지 않는다 — 조용해야 할 곳이다', async () => {
    await useFoldersStore.getState().create('Books')
    const folder = useFoldersStore.getState().folders[0]
    await useDocumentsStore.getState().create({
      title: 'Haus',
      languageCode: 'de',
      rawText: 'Das Haus ist groß.',
      fallbackTitle: 'Untitled',
    })
    const doc = useDocumentsStore.getState().documents[0]
    await useDocumentsStore.getState().moveToFolder([doc.id], folder.id)
    const after = useDocumentsStore.getState().documents.find((d) => d.id === doc.id)

    await useDocumentsStore.getState().moveToFolder([doc.id], folder.id)
    expect(
      useDocumentsStore.getState().documents.find((d) => d.id === doc.id)?.folderUpdatedAt,
    ).toBe(after?.folderUpdatedAt)
  })
})

describe('sameFolders', () => {
  it('같은 내용이면 같다 — 갈아끼우지 않게 하는 근거다', () => {
    const a = [folder({ id: 'f1' })]
    expect(sameFolders(a, [...a])).toBe(true)
    expect(sameFolders(a, [{ ...folder({ id: 'f1' }), name: 'Other' }])).toBe(false)
    expect(sameFolders(a, [{ ...folder({ id: 'f1' }), parentId: 'p1' }])).toBe(false)
  })
})

describe('load 는 톰스톤을 가린다', () => {
  it('지운 폴더는 목록에 없다', async () => {
    const created = await useFoldersStore.getState().create('Reading')
    await useFoldersStore.getState().deleteFolder(created!.id)
    await useFoldersStore.getState().load()
    expect(useFoldersStore.getState().folders).toHaveLength(0)
  })
})

describe('moveFolder', () => {
  it('부모를 바꾼다 — 문서를 건드리지 않는다', async () => {
    const parent = await useFoldersStore.getState().create('Books')
    const other = await useFoldersStore.getState().create('Other')
    const child = await useFoldersStore.getState().create('Novels', parent!.id)

    await useDocumentsStore.getState().create({
      title: 'Haus',
      languageCode: 'de',
      rawText: 'Das Haus ist groß.',
      fallbackTitle: 'Untitled',
    })
    const doc = useDocumentsStore.getState().documents[0]
    await useDocumentsStore.getState().moveToFolder([doc.id], child!.id)
    const openedAt = useDocumentsStore.getState().documents[0].updatedAt

    expect(await useFoldersStore.getState().moveFolder(child!.id, other!.id)).toBe(true)
    expect(
      useFoldersStore.getState().folders.find((f) => f.id === child!.id)?.parentId,
    ).toBe(other!.id)
    expect(
      useDocumentsStore.getState().documents.find((d) => d.id === doc.id)?.updatedAt,
    ).toBe(openedAt)
  })

  it('자기 자신과 자손으로는 옮기지 않는다 — 순환 금지', async () => {
    const parent = await useFoldersStore.getState().create('Books')
    const child = await useFoldersStore.getState().create('Novels', parent!.id)

    expect(await useFoldersStore.getState().moveFolder(parent!.id, parent!.id)).toBe(
      false,
    )
    expect(await useFoldersStore.getState().moveFolder(parent!.id, child!.id)).toBe(
      false,
    )
    expect(
      useFoldersStore.getState().folders.find((f) => f.id === parent!.id)?.parentId,
    ).toBeNull()
  })

  it('없어진 폴더로는 옮기지 않는다', async () => {
    const parent = await useFoldersStore.getState().create('Books')
    const child = await useFoldersStore.getState().create('Novels', parent!.id)
    const gone = await useFoldersStore.getState().create('Gone')
    await useFoldersStore.getState().deleteFolder(gone!.id)

    expect(await useFoldersStore.getState().moveFolder(child!.id, gone!.id)).toBe(false)
    expect(await useFoldersStore.getState().moveFolder(child!.id, 'no-such-id')).toBe(
      false,
    )
    expect(
      useFoldersStore.getState().folders.find((f) => f.id === child!.id)?.parentId,
    ).toBe(parent!.id)
  })
})
