/**
 * 익명 사용량 쿼터의 순수 계산부.
 *
 * Deno 나 Supabase 를 import 하지 않는다 — DB/RPC 는 호출자가 주입하고
 * 여기서는 "어떤 버킷을 얼마나" 와 "거부되면 즉시 멈춘다" 만 결정한다.
 * 이렇게 두면 Deno 없이 vitest 로 규칙을 고정할 수 있다.
 */

export type QuotaLimit = {
  bucket: string
  limit: number
  windowSeconds: number
}

const HOUR = 3600
const DAY = 86_400

const ROUTE_LIMITS = {
  translate: { install: 200, ip: 100, global: 10_000 },
  dictionary: { install: 600, ip: 300, global: 30_000 },
} as const

/** 지금이 속한 고정 창의 시작 시각. 경계가 흔들리지 않도록 UTC epoch 기준으로 내린다. */
export function quotaWindowStart(nowMs: number, windowSeconds: number): number {
  return Math.floor(nowMs / (windowSeconds * 1000)) * windowSeconds * 1000
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * IP 는 없을 수 있다 (프록시가 헤더를 안 줄 때). 그때는 모두를 한 버킷에 몰아
 * 사실상 IP 별 제한을 포기하되, 전역 제한은 그대로 남긴다.
 */
function normalizeIp(ip: string): string {
  const trimmed = ip?.trim() ?? ''
  return trimmed === '' ? 'unknown' : trimmed
}

/**
 * 버킷 이름에는 원문(설치 ID, IP)을 남기지 않는다. 로그/DB 에 개인 식별자가
 * 그대로 쌓이지 않도록 해시만 쓴다. 같은 입력이면 같은 해시라 집계는 유지된다.
 */
export async function makeQuotaLimits(
  route: 'translate' | 'dictionary',
  installId: string,
  ip: string,
): Promise<QuotaLimit[]> {
  const limits = ROUTE_LIMITS[route]

  const [globalBucket, ipBucket, installBucket] = await Promise.all([
    sha256Hex(`${route}:global`),
    sha256Hex(`${route}:ip:${normalizeIp(ip)}`),
    sha256Hex(`${route}:install:${installId}`),
  ])

  return [
    { bucket: globalBucket, limit: limits.global, windowSeconds: DAY },
    { bucket: ipBucket, limit: limits.ip, windowSeconds: HOUR },
    { bucket: installBucket, limit: limits.install, windowSeconds: HOUR },
  ]
}

/**
 * 앞의 제한부터 차례로 소비한다. 하나라도 거부되면 뒤는 시도하지 않는다 —
 * 거부된 요청이 다른 버킷까지 깎아먹으면 정상 사용자만 불리해진다.
 * 오류는 잡지 않는다. 호출자가 503 으로 매핑한다.
 */
export async function enforceQuota(
  consume: (bucket: string, limit: number, windowSeconds: number) => Promise<boolean>,
  limits: QuotaLimit[],
): Promise<boolean> {
  for (const { bucket, limit, windowSeconds } of limits) {
    const allowed = await consume(bucket, limit, windowSeconds)
    if (!allowed) return false
  }
  return true
}
