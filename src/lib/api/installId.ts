/**
 * 이 기기의 설치 식별자.
 *
 * 계정 없이도 번역을 쓸 수 있게 두되, 익명 남용은 쿼터로 막는다.
 * 그 쿼터의 한 축이 이 ID 이므로 저장소가 아플 때도 값은 반드시 돌려준다 —
 * 저장에 실패했다고 번역까지 막으면 사용자 잘못이 아닌 일로 서비스를 잃는다.
 */

export const INSTALL_ID_KEY = 'lexi.installId'

/** v4 모양만 받는다. 버전/변형 자리까지 봐야 다른 UUID 를 설치 ID 로 오인하지 않는다. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type InstallIdStorage = Pick<Storage, 'getItem' | 'setItem'>

/**
 * 기본 저장소는 모듈 로드 시점이 아니라 호출 시점에 찾는다.
 * 테스트가 localStorage 를 갈아끼울 수 있고, SSR/Node 처럼 아예 없는 환경도 있기 때문이다.
 */
function defaultStorage(): InstallIdStorage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    // 샌드박스 iframe 등에서는 접근 자체가 던진다
    return undefined
  }
}

export function readOrCreateInstallId(storage?: InstallIdStorage): string {
  const store = storage ?? defaultStorage()

  let existing: string | null = null
  try {
    existing = store?.getItem(INSTALL_ID_KEY) ?? null
  } catch {
    existing = null
  }

  if (existing && UUID_SHAPE.test(existing)) return existing

  const id = crypto.randomUUID()
  try {
    store?.setItem(INSTALL_ID_KEY, id)
  } catch {
    // 사생활 보호 모드/용량 초과. 이번 호출은 메모리 값으로 살아간다.
  }
  return id
}
