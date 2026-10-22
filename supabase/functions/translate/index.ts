import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

import { enforceQuota, makeQuotaLimits } from '../_shared/quota.ts'

/**
 * POST /functions/v1/translate
 *
 * { sourceLanguage, targetLanguage, text } → { translatedText, cached }
 *
 * API 키는 함수 시크릿에만 존재한다. 클라이언트가 직접 Google을 호출하면
 * 키가 번들에 들어가기 때문이다 (PLAN.md §6).
 */

const GOOGLE_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2'

/** 과도한 요청으로 할당량 소진을 막는다 */
const MAX_CHARS = 5000
/** 본문 전체 상한 — JSON 을 읽기 전에 Content-Length 로 거른다 */
const MAX_BODY_BYTES = 20_000
/** Google 이 응답하지 않을 때 기다리는 시간 */
const PROVIDER_TIMEOUT_MS = 10_000

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-lexi-install',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const LANGUAGE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/
/** 설치 ID 는 UUID 모양만 받는다 — 아니면 익명 버킷으로 묶는다 */
const INSTALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

/** Google은 format=text 로 호출하면 HTML 엔티티로 반환한다 */
function decodeEntities(input: string): string {
  return input
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 캐시 쓰기에는 RLS를 우회할 수 있는 서비스 롤이 필요하다 */
function createServiceClient() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
}

/** 형식이 틀린 설치 ID 는 조용히 익명으로 본다 — 요청 자체를 막지는 않는다 */
function readInstallId(req: Request): string {
  const raw = req.headers.get('x-lexi-install')?.trim() ?? ''
  return INSTALL_ID_RE.test(raw) ? raw.toLowerCase() : 'anonymous'
}

/** 프록시가 준 첫 클라이언트 IP. 없으면 모두를 한 버킷에 묶는다. */
function readClientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (forwarded) return forwarded
  return req.headers.get('x-real-ip')?.trim() || 'unknown'
}

/** 선언된 본문 길이만 본다 — 실제 바이트 수는 읽은 뒤에야 알 수 있다 */
function bodyTooLarge(req: Request): boolean {
  const declared = req.headers.get('content-length')
  if (declared === null) return false
  const bytes = Number(declared)
  return Number.isFinite(bytes) && bytes > MAX_BODY_BYTES
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  // 본문을 읽기 전에 걸러야 큰 요청이 파싱 비용을 쓰지 않는다
  if (bodyTooLarge(req)) return json({ error: 'request body too large' }, 413)

  const apiKey = Deno.env.get('GOOGLE_TRANSLATE_API_KEY')
  if (!apiKey) return json({ error: 'GOOGLE_TRANSLATE_API_KEY is not configured' }, 500)

  let payload: { sourceLanguage?: string; targetLanguage?: string; text?: string }
  try {
    payload = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  const source = payload.sourceLanguage ?? ''
  const target = payload.targetLanguage ?? 'en'
  const text = (payload.text ?? '').trim()

  if (!LANGUAGE_RE.test(source) || !LANGUAGE_RE.test(target)) {
    return json({ error: 'invalid language code' }, 400)
  }
  if (text.length === 0) return json({ error: 'text is required' }, 400)
  if (text.length > MAX_CHARS) return json({ error: `text exceeds ${MAX_CHARS} characters` }, 413)

  const client = createServiceClient()

  // 로그인을 강제하지 않는다 — 대신 설치 ID / IP / 전역 버킷으로 비용을 제한한다.
  // 하드 인증은 Release 5 의 제품 결정이라 여기서는 쿼터가 안전장치다.
  try {
    const limits = await makeQuotaLimits('translate', readInstallId(req), readClientIp(req))
    const allowed = await enforceQuota(async (bucket, limit, windowSeconds) => {
      const { data, error } = await client.rpc('consume_function_quota', {
        p_bucket: bucket,
        p_limit: limit,
        p_window_seconds: windowSeconds,
      })
      if (error) throw error
      return Boolean(data)
    }, limits)

    if (!allowed) return json({ error: 'rate limit exceeded' }, 429)
  } catch (error) {
    // 쿼터를 확인할 수 없으면 통과시키지 않는다 (fail closed)
    console.error('translate quota check failed', error)
    return json({ error: 'quota check unavailable' }, 503)
  }

  // Google 은 en|en 같은 동일 언어쌍을 "Bad language pair" 로 거절한다.
  // 영어 학습자가 자기 글을 여는 경로가 바로 이것이므로 원문을 그대로 돌려준다.
  if (source === target) return json({ translatedText: text, cached: false, identity: true })

  const hash = await sha256Hex(text)

  const { data: cached } = await client
    .from('translation_cache')
    .select('translated_text')
    .eq('source_language', source)
    .eq('target_language', target)
    .eq('source_hash', hash)
    .maybeSingle()

  if (cached) return json({ translatedText: cached.translated_text, cached: true })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS)

  let googleRes: Response
  try {
    googleRes = await fetch(`${GOOGLE_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source, target, format: 'text' }),
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) {
      return json({ error: 'translation provider timed out' }, 504)
    }
    // 오류 메시지에 원문이 섞일 수 있으므로 이름만 남긴다
    console.error(
      'google translate request failed',
      error instanceof Error ? error.name : 'unknown error',
    )
    return json({ error: 'translation provider unreachable' }, 504)
  } finally {
    clearTimeout(timer)
  }

  if (!googleRes.ok) {
    // Google 은 오류 본문에 원문을 그대로 돌려줄 수 있다 — 상태 코드만 남긴다
    console.error('google translate failed', googleRes.status)
    return json({ error: 'translation provider rejected the request' }, 502)
  }

  const body = await googleRes.json()
  const translatedText = body?.data?.translations?.[0]?.translatedText
  if (typeof translatedText !== 'string') {
    return json({ error: 'unexpected provider response' }, 502)
  }

  const decoded = decodeEntities(translatedText)

  // 캐시 저장이 실패해도 번역 결과는 그대로 돌려준다.
  // 원문은 저장하지 않는다 — 조회 키인 source_hash 만 남긴다.
  const { error: cacheError } = await client.from('translation_cache').insert({
    source_language: source,
    target_language: target,
    source_hash: hash,
    translated_text: decoded,
  })
  if (cacheError) console.error('translation cache insert failed', cacheError.message)

  return json({ translatedText: decoded, cached: false })
})