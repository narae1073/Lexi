import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const LANGUAGE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

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

  // Google 은 en|en 같은 동일 언어쌍을 "Bad language pair" 로 거절한다.
  // 영어 학습자가 자기 글을 여는 경로가 바로 이것이므로 원문을 그대로 돌려준다.
  if (source === target) return json({ translatedText: text, cached: false, identity: true })

  const hash = await sha256Hex(text)
  const client = createServiceClient()

  const { data: cached } = await client
    .from('translation_cache')
    .select('translated_text')
    .eq('source_language', source)
    .eq('target_language', target)
    .eq('source_hash', hash)
    .maybeSingle()

  if (cached) return json({ translatedText: cached.translated_text, cached: true })

  const googleRes = await fetch(`${GOOGLE_ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, source, target, format: 'text' }),
  })

  if (!googleRes.ok) {
    const detail = await googleRes.text()
    console.error('google translate failed', googleRes.status, detail.slice(0, 400))
    return json({ error: 'translation provider rejected the request' }, 502)
  }

  const body = await googleRes.json()
  const translatedText = body?.data?.translations?.[0]?.translatedText
  if (typeof translatedText !== 'string') {
    return json({ error: 'unexpected provider response' }, 502)
  }

  const decoded = decodeEntities(translatedText)

  // 캐시 저장이 실패해도 번역 결과는 그대로 돌려준다
  const { error: cacheError } = await client.from('translation_cache').insert({
    source_language: source,
    target_language: target,
    source_hash: hash,
    source_text: text,
    translated_text: decoded,
  })
  if (cacheError) console.error('translation cache insert failed', cacheError.message)

  return json({ translatedText: decoded, cached: false })
})