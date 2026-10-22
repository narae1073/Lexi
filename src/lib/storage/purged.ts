/**
 * 완전 삭제한 문서의 흔적.
 *
 * **왜 필요한가**
 *
 * 완전 삭제는 이 기기에서 지운 뒤 서버에도 지우라고 요청한다. 그런데 서버 삭제와
 * 동기화가 겹칠 수 있다 — 동기화가 서버를 읽는 사이에 삭제 요청이 아직 도착하지 않았으면
 * 지운 문서가 그대로 내려온다. 병합은 그 문서를 되살리고, 다음 동기화는 그걸 서버에
 * 다시 올린다. 지운 문서가 영구히 되살아난다.
 *
 * 그래서 이 기기에서 지웠다고 **기억해 둔다.** 서버가 무엇을 돌려주든 다시 받지 않는다.
 *
 * 언제 잊지 않나 — 절대 잊지 않는다. '완전 삭제' 의 뜻이 그것이다. id 는 uuid 라 다시
 * 쓰이지 않으므로, 목록이 조금 자라는 것이 되살아나는 것보다 낫다.
 */

import { STORES, idbGetAll, idbPut } from './localDb'

const KEY = 'lexi.purged'

/** 이 기기에서 완전 삭제한 문서 — 행이 사라진 뒤에도 남는 묘비 */
export type DocumentTombstone = {
  documentId: string
  purgedAt: string
}

/**
 * Sentinel `purgedAt` for a tombstone promoted from the legacy localStorage
 * purge list.
 *
 * Those IDs carry no deletion time, and the tombstone may already have been
 * written to IndexedDB by an older build with this exact value. The push path
 * treats this sentinel as always eligible so a legacy deletion can never be
 * suppressed forever by a tombstones watermark.
 */
export const LEGACY_PURGE_AT = new Date(0).toISOString()

/**
 * 완전 삭제를 기기에 남긴다 — 동기화가 이 목록을 서버로 보낸다.
 *
 * localStorage 목록은 같은 기기에서 곧바로 다시 받지 않기 위한 빠른 방어다.
 * 계정 사이에 지운 사실을 나누는 것은 이 IndexedDB 묘비가 맡는다.
 */
export async function putDocumentTombstone(
  documentId: string,
  purgedAt = new Date().toISOString(),
): Promise<void> {
  await idbPut(STORES.documentTombstones, { documentId, purgedAt })
}

export async function readDocumentTombstones(): Promise<DocumentTombstone[]> {
  return idbGetAll<DocumentTombstone>(STORES.documentTombstones)
}

export function markPurged(id: string): void {
  try {
    const ids = purgedDocumentIds()
    if (ids.includes(id)) return
    localStorage.setItem(KEY, JSON.stringify([...ids, id]))
  } catch (error) {
    // 저장할 수 없어도 삭제는 진행한다 — 막지 않는다
    console.error('완전 삭제 표시를 저장하지 못함', error)
  }
}

export function isPurged(id: string): boolean {
  return purgedDocumentIds().includes(id)
}

export function purgedDocumentIds(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    // 읽지 못해도 조용히 없는 것으로 본다 — 서버 것을 그대로 쓰게 될 뿐이다
    return []
  }
}