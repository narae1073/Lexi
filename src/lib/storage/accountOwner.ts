/**
 * 이 기기가 어느 계정의 것인가 — 그리고 그 사실로 무엇을 할 수 있는가.
 *
 * **왜 필요한가**
 *
 * 기기에는 로그인 전에 만든 기록이 남을 수 있다. 그 기록을 아무 계정에나 이어 붙이면
 * 남의 기록이 섞인다. 반대로 로그아웃했다고 기기 기록을 지우면 사용자는 이유 없이
 * 자기 기록을 잃는다. 그래서 기기에 '소유자 표시' 하나를 남기고, 로그인한 계정과
 * 견주어 무엇을 할지 정한다.
 *
 * - 아직 주인이 없는 기기 데이터는 계정으로 넘겨받을지 물어본다 (`claim`).
 * - '이 기기만 쓰기' 를 고르면 그 결정을 기억하고 다시 묻지 않는다 (`local`).
 * - 다른 계정의 표시가 남아 있으면 그 데이터를 새 계정으로 올리지 않는다 (`blocked`).
 *
 * 이 파일은 순수하다 — React, IndexedDB, Supabase 를 모른다. 저장소는 localStorage
 * 계약만 빌려 쓴다.
 */

export const LOCAL_OWNER_KEY = 'lexi.localOwner'

/** 이 기기의 소유자 — 아직 주인 없는 기기이거나, 계정에 묶였거나, 기기 전용이거나 */
export type LocalOwner =
  | { kind: 'local'; kept?: boolean }
  | { kind: 'user'; userId: string }

/** 로그인한 계정과 기기 기록으로 정해진 동기화 범위 */
export type AccountScope = 'sync' | 'local' | 'claim' | 'blocked'

/** localStorage 중 이 모듈이 쓰는 부분 — 시험과 SSR 을 위해 주입할 수 있다 */
export type OwnerStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/**
 * 저장된 소유자 표시를 읽는다.
 *
 * 읽을 수 없거나 뜻이 분명하지 않으면 null 이다 — 모르는 것을 추측하지 않는다.
 * 모르면 '아직 주인 없음' 으로 다루는 편이, 남의 계정에 기록을 붙이는 것보다 안전하다.
 */
export function readLocalOwner(storage?: OwnerStorage): LocalOwner | null {
  try {
    // localStorage 자체를 꺼내는 것도 막힐 수 있다 — 그 경우까지 조용히 넘긴다
    const target = storage ?? globalThis.localStorage
    const raw = target.getItem(LOCAL_OWNER_KEY)
    if (!raw) return null

    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

    const record = parsed as Record<string, unknown>

    if (record.kind === 'local') {
      // kept 는 오직 true 일 때만 뜻이 있다 — 그 밖의 값은 '아직 고르지 않음' 이다
      return { kind: 'local', kept: record.kept === true }
    }

    if (record.kind === 'user') {
      const userId = record.userId
      if (typeof userId !== 'string' || userId === '') return null
      return { kind: 'user', userId }
    }

    return null
  } catch {
    // 저장소를 읽지 못해도 앱을 막지 않는다 — 없는 것으로 본다
    return null
  }
}

/**
 * 소유자 표시를 적는다.
 *
 * 저장에 실패해도 던지지 않는다. localStorage 를 쓸 수 없다고 해서 사용자가
 * 하던 일을 잃어서는 안 된다.
 */
export function writeLocalOwner(owner: LocalOwner, storage?: OwnerStorage): void {
  try {
    const target = storage ?? globalThis.localStorage
    target.setItem(LOCAL_OWNER_KEY, JSON.stringify(owner))
  } catch (error) {
    console.error('계정 소유자 표시를 저장하지 못함', error)
  }
}

export function clearLocalOwner(storage?: OwnerStorage): void {
  try {
    const target = storage ?? globalThis.localStorage
    target.removeItem(LOCAL_OWNER_KEY)
  } catch (error) {
    console.error('계정 소유자 표시를 지우지 못함', error)
  }
}

/**
 * 로그인한 계정과 기기 기록으로 지금 무엇을 해야 하는지 정한다.
 *
 * | 소유자 | 계정 | 기기 데이터 | 결과 |
 * |---|---|---|---|
 * | 무엇이든 | 없음 | 무엇이든 | local |
 * | 없음 / 아직 안 넘겨받음 | 있음 | 없음 | sync |
 * | 없음 / 아직 안 넘겨받음 | 있음 | 있음 | claim |
 * | 기기만 쓰기(kept) | 있음 | 무엇이든 | local |
 * | 같은 계정 | 있음 | 무엇이든 | sync |
 * | 다른 계정 | 있음 | 무엇이든 | blocked |
 */
export function resolveAccountScope(input: {
  owner: LocalOwner | null
  userId: string | null
  hasLocalData: boolean
}): AccountScope {
  const { owner, userId, hasLocalData } = input

  // 로그아웃 상태 — 기기 기록은 그대로 기기에 둔다
  if (userId === null) return 'local'

  if (owner === null) return hasLocalData ? 'claim' : 'sync'

  if (owner.kind === 'user') {
    return owner.userId === userId ? 'sync' : 'blocked'
  }

  // '이 기기만 쓰기' 는 이미 내린 결정이다 — 다시 묻지 않는다
  if (owner.kept === true) return 'local'

  // 아직 주인이 없는 기기 기록 — 계정으로 넘겨받을지 물어본다
  return hasLocalData ? 'claim' : 'sync'
}
