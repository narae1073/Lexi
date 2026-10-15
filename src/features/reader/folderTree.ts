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

/**
 * 폴더의 모든 자손 — 직접 아이부터 그 아래까지 (가장 가까운 것부터).
 *
 * 폴더를 옮길 때 잠글 대상(자기 자신 + 자손)과, 겹쳐 체크된 폴더를
 * 가지치는 데 쓴다. 데이터가 깨져 순환을 만들더라도 무한히 돌지 않는다.
 */
export function descendantsOf(folders: Folder[], folderId: string): Folder[] {
  const live = liveFolders(folders)
  const seen = new Set<string>([folderId])
  const result: Folder[] = []
  let frontier = childrenOf(live, folderId)
  // 보호 — ancestorsOf 와 같은 이유다
  let guard = 0
  while (frontier.length > 0 && guard++ < 100) {
    const next: Folder[] = []
    for (const folder of frontier) {
      if (seen.has(folder.id)) continue
      seen.add(folder.id)
      result.push(folder)
      next.push(...childrenOf(live, folder.id))
    }
    frontier = next
  }
  return result
}

/**
 * 뿌리 자리에 보이는 폴더 — 직접 뿌리인 것과 부모를 잃은 것.
 *
 * 다른 기기에서 부모를 지우는 사이에는 살아 있는 폴더가 톰스톤을 가리킬 수
 * 있다. 그런 폴더를 어디에도 보여 주지 않으면 동기화는 됐는데 화면에 없는
 * 폴더가 된다 — 문서의 folderOfDocument 와 같은 규칙으로 뿌리로 올린다.
 */
export function visibleRoots(folders: Folder[]): Folder[] {
  const live = liveFolders(folders)
  const liveIds = new Set(live.map((folder) => folder.id))
  const roots = live.filter((folder) => folder.parentId === null)
  const orphans = live.filter(
    (folder) => folder.parentId !== null && !liveIds.has(folder.parentId),
  )
  return [...roots, ...orphans]
}

/**
 * 겹쳐 체크된 폴더를 가지친다 — 입력 순서를 지키고 부모만 남긴다.
 *
 * 부모 P 와 자식 C 를 함께 옮기면 C 는 P 안에 딸려 가므로, C 의 체크는
 * 무시한다 (나무가 조용히 납작해지는 것을 막는다). 모르는 id 는 그대로 둔다.
 */
export function pruneNestedTicks(
  folders: Folder[],
  tickedFolderIds: readonly string[],
): string[] {
  const ticked = new Set(tickedFolderIds)
  return tickedFolderIds.filter((id) => {
    for (const other of ticked) {
      if (other === id) continue
      if (descendantsOf(folders, other).some((folder) => folder.id === id)) {
        return false
      }
    }
    return true
  })
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
