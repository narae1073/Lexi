import type { Folder } from '../../types'

/**
 * 폴더의 모양을 다루는 순수 함수들.
 *
 * UI 는 살아 있는 폴더만 보고, 이 순수 모듈이 '상위 폴더'·'빈 폴더' 같은 질문에
 * 답한다. 병합이 톰스톤(삭제 기록)을 가진 행을 저장소에 남겨 두므로, 화면으로
 * 가기 전에 가리는 일이 필요하다 — 문서 휴지통이 목록 밖에 있는 것과 같은 규칙이다.
 */

/** 휴지통에 버려지지 않은 폴더 */
export function liveFolders(folders: Folder[]): Folder[] {
  return folders.filter((folder) => !folder.deletedAt)
}

/** 어떤 폴더의 직접 아이들 — parentId 로 묶인다 */
export function childrenOf(folders: Folder[], parentId: string | null): Folder[] {
  return folders.filter((folder) => folder.parentId === parentId)
}

/**
 * 문서가 실제로 속한 폴더 — 폴더가 없어졌으면 폴더에 없는 것으로 본다.
 *
 * 폴더를 지우면 그 안의 문서를 부모로 옮겨 놓지만, 옮기고 가는 사이(다른 기기에서
 * 만든 기록)에는 톰스톤을 가리키는 문서가 남을 수 있다. 묻힌 문서를 '사라진
 * 문서'로 보여 주면 거짓말이다 — 뿌리로 돌려 보여 준다.
 */
export function folderOfDocument(
  folders: Folder[],
  folderId: string | null | undefined,
): Folder | null {
  if (!folderId) return null
  return liveFolders(folders).find((folder) => folder.id === folderId) ?? null
}

/**
 * 폴더의 조상 — 자기 자신을 포함한다 (가장 가까운 조상부터 루트까지).
 *
 * 새 폴더를 어디에 만들지 고르기 전에 자기 자신이 조상인 경우를 걸러 내는 데
 * 쓴다. 중첩 UI(Phase 2)에서 폴더를 자기 자신의 자손 안으로 옮기는 것을 막는
 * 근거이기도 하다 — 순환이 만들어지면 목록이 영원히 열리지 않는다.
 */
export function ancestorsOf(folders: Folder[], folderId: string): Folder[] {
  /** id → 폴더. 같은 id 가 여러 개일 수 없지만, 찾기 매번 순회하지 않게 한 번 만든다 */
  const byId = new Map(
    liveFolders(folders).map((folder) => [folder.id, folder] as const),
  )

  const chain: Folder[] = []
  let current: Folder | undefined = byId.get(folderId)
  while (current) {
    chain.push(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
    // 보호 — 데이터가 깨져 순환을 만들더라도 무한히 돌지 않는다
    if (chain.length > 100) break
  }
  return chain
}
