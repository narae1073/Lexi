import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

import {
  INFLECTION_VERSION,
  isFormOf,
  lookupCandidates,
  referencedHeadwords,
  type Candidate,
} from '../_shared/inflection.ts'
import { pinyinToneMarks } from '../_shared/ccCedict.ts'
import { enforceQuota, makeQuotaLimits } from '../_shared/quota.ts'

/**
 * POST /functions/v1/dictionary
 *
 * { languageCode, lemma, surface, targetLanguage? } → 정규화된 사전 엔트리
 *
 * 활용형 표기를 클릭하면 표기 자체의 항목과 기본형 항목을 함께 돌려준다.
 *   영어  running → [running 항목, run 기본형 항목]
 *   독일어 Kinder  → Kinder 항목은 형식 참조뿐이라 [Kind 항목] 만
 *   한국어 속는다   → 표기 항목이 없어 [속다 항목] 만
 *
 * lemma 은 캐시 키이자 소문자 정규형이고, surface 는 원문 표기다.
 * 독일어처럼 명사를 대문자로 쓰는 언어는 표기를 보존해야 사전이 잡힌다.
 *
 * 중국어는 CC-CEDICT 자체 테이블을 본다 (무료, 쿼터 없음).
 * lindera 가 합친 단어(北京大学)가 사전 항목과 같은 단위라 맞아떨어진다.
 * CC-CEDICT 는 중영 전용이라 목표 언어가 영어가 아닐 땐 기존 경로로 간다 —
 * 캐시 키에 목표 언어를 넣어 섞이지 않게 한다.
 *
 * 출처는 English Wiktionary (CC BY-SA 4.0) 기반의 freedictionaryapi.com.
 * 키가 필요 없고 무료다. 비영어 언어를 배워도 정의는 영어로 온다 —
 * 별도 번역 파이프라인이 필요 없던 이유다 (PLAN.md §8-1).
 */

const UPSTREAM = 'https://freedictionaryapi.com/api/v1/entries'
const UPSTREAM_TIMEOUT_MS = 8000
/** 후보/원형어를 모두 조회해도 이 시간을 넘기지 않는다 */
const OVERALL_TIMEOUT_MS = 20_000

/** 본문 전체 상한 — JSON 을 읽기 전에 Content-Length 로 거른다 */
const MAX_BODY_BYTES = 20_000

/** 조작을 막기 위한 상한 */
const MAX_LEMMA_CHARS = 64
/** 표기는 원문 그대로 오므로 넉넉히 두되 문장이 들어오지는 못하게 한다 */
const MAX_SURFACE_CHARS = 128
/** 표기 → 활용형 후보를 모두 합쳐도 이 수를 넘지 않는다 */
const MAX_CANDIDATES = 6
/** 형식 참조를 따라갈 때 시도할 원형어 수 */
const MAX_HEADWORDS = 2
/**
 * 항목당 senses 수와 예문 수.
 * en/run 은 뜻이 38개나 되므로 전부 넣으면 박스가 화면을 넘긴다.
 * 깊은 내용은 위키낱말 출처 링크에서 보는 게 맞다.
 */
const MAX_SENSES_PER_PART = 4
const MAX_PARTS = 4
const MAX_PHONETICS = 4
const MAX_EXAMPLES_PER_SENSE = 1

/** CC-CEDICT 한 항목이 만드는 섹션 수 — 和 같은 다독음자는 섹션이 여럿이다 */
const MAX_CEDICT_READINGS = 4
/** CC-CEDICT 뜻 수 — 영어 위키낱말 경로의 상한과 맞춘다 */
const MAX_CEDICT_SENSES = 4

/**
 * 캐시 페이로드의 스키마 버전.
 *
 * 정규화/후보 규칙을 바꿀 때마다 **반드시 올려라**. 안 올리면 옛에 저장된
 * 잘못된 결과(예: German Haus 를 동사 haus 로 잡은 값)가 그대로 살아남는다.
 * 올리면 이전 행은 자동으로 무효가 되고 다음 요청에서 다시 조회한다.
 */
/** 응답 구조의 버전 */
const SCHEMA_VERSION = '6'

/**
 * 캐시 페이로드 버전 = 구조 버전 + 활용 규칙 버전.
 * 활용 규칙을 고칠 때 이 상수를 따로 올리는 걸 잊지 않도록 규칙 버전을 자동으로 포함한다.
 */
const PAYLOAD_VERSION = `${SCHEMA_VERSION}/infl${INFLECTION_VERSION}`

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-lexi-install',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const LANGUAGE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/
/** 설치 ID 는 UUID 모양만 받는다 — 아니면 익명 버킷으로 묶는다 */
const INSTALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** 전체 조회 데드라인을 넘겼다는 내부 신호 — 바깥 catch 가 504 로 바꾼다 */
class DeadlineExceededError extends Error {}

/**
 * 명사를 관례적으로 대문자로 쓰는 언어.
 *
 * 이런 언어는 표기를 먼저 조회해야 한다. 소문자를 먼저 보면
 * de/Haus 가 명사 "house" 가 아니라 동사 hausen 의 "haus" 로 잡힌다.
 *
 * 반대로 이런 언어가 아닌 곳에서는 소문자를 먼저 본다. 영어 문장 첫 단어 Running 은
 * 대문자 표기가 proper noun "Running"(성) 항목으로 잡히고, 뜻이 소문자 running 이다.
 * 우리 화이트리스트(PLAN.md)에서는 German 만 해당한다.
 */
const CAPITALIZES_NOUNS = new Set([
  'de',
  'da', 'nb', 'no', 'nn', 'is', 'fi', 'et', 'sv', 'tr',
  'pl', 'cs', 'sk', 'hu', 'lt', 'lv', 'sq', 'hr', 'sr', 'bs', 'sl', 'mk', 'ro',
])

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

// ── upstream 타입 ────────────────────────────────────────────────────────

type UpstreamSense = { definition?: string; tags?: string[]; examples?: string[] }

type UpstreamEntry = {
  partOfSpeech?: string
  pronunciations?: { type?: string; text?: string }[]
  senses?: UpstreamSense[]
}

type UpstreamBody = {
  entries?: UpstreamEntry[]
  source?: { url?: string; license?: { name?: string } }
}

/** 화면으로 내보내는 정규화된 뜻 하나 */
type Sense = { definition: string; tags: string[]; examples: string[] }
type Part = { partOfSpeech: string; senses: Sense[] }

/** 표기 항목 또는 기본형 항목 하나 */
type Section = {
  form: string
  role: 'surface' | 'base'
  phonetics: string[]
  parts: Part[]
  source: { url: string; license: string; name: string }
}

// ── 정규화 ────────────────────────────────────────────────────────────────

/** 실제 뜻(gloss)이 하나라도 있는가 — 형식 참조만 있으면 없는 것으로 본다 */
function hasRealGloss(entries: UpstreamEntry[] | undefined): boolean {
  return (entries ?? []).some((e) =>
    (e.senses ?? []).some((s) => s.definition?.trim() && !isFormOf(s.tags)),
  )
}

function normalizeParts(body: UpstreamBody): Part[] {
  return (body.entries ?? []).slice(0, MAX_PARTS).map((entry) => ({
    partOfSpeech: entry.partOfSpeech ?? '',
    senses: (entry.senses ?? [])
      .filter((s) => typeof s.definition === 'string' && s.definition.trim().length > 0)
      .map((s) => ({
        definition: s.definition!.trim(),
        tags: (s.tags ?? []).slice(0, 4),
        examples: (s.examples ?? []).filter(Boolean).slice(0, MAX_EXAMPLES_PER_SENSE),
      }))
      // 'form of' 항목은 "plural of Kind" 같은 문법 참조라 뜻이 아니다. 진짜 gloss 가 앞에 오도록 뒤로 보낸다.
      .sort((a, b) => Number(isFormOf(a.tags)) - Number(isFormOf(b.tags)))
      .slice(0, MAX_SENSES_PER_PART),
  }))
}

function normalizePhonetics(body: UpstreamBody): string[] {
  return [
    ...new Set(
      (body.entries ?? [])
        .flatMap((e) => e.pronunciations ?? [])
        .filter((p) => p.type === 'ipa' && p.text?.trim())
        .map((p) => p.text!.trim()),
    ),
  ].slice(0, MAX_PHONETICS)
}

/**
 * 뜻이 가리키는 원형어를 뽑는다.
 *
 * 두 종류가 있다.
 *  1) 위키낱말이 'form of' 로 표시한 항목 — "plural of Kind"
 *  2) 활용 형태를 설명하는 뜻 — "present participle and gerund of run"
 *     (2번은 태그가 없어서 1번만 보면 놓친다)
 *
 * 활용어를 나열한 뒤 "of X" 로 끝나는 경우만 받는 것으로 오탐을 막는다.
 * "a kind of X" 같은 일반 표현은 매칭되지 않는다.
 */
function toSection(form: string, role: Section['role'], body: UpstreamBody): Section {
  return {
    form,
    role,
    phonetics: normalizePhonetics(body),
    parts: normalizeParts(body).filter((part) => part.senses.length > 0),
    source: {
      url: body.source?.url ?? `https://en.wiktionary.org/wiki/${encodeURIComponent(form)}`,
      license: body.source?.license?.name ?? 'CC BY-SA 4.0',
      name: 'Wiktionary',
    },
  }
}

// ── upstream 통신 ─────────────────────────────────────────────────────────

/** 같은 단어가 여러 경로로 나와도 최초 출처를 유지한다 */
function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const byWord = new Map<string, Candidate>()
  for (const candidate of candidates) {
    if (!byWord.has(candidate.word)) byWord.set(candidate.word, candidate)
  }
  return [...byWord.values()]
}

/** 404 는 '없음' 으로 취급하고, 그 밖의 실패만 전체 실패로 본다. */
async function fetchUpstream(languageCode: string, word: string): Promise<UpstreamBody | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)

  try {
    const res = await fetch(`${UPSTREAM}/${languageCode}/${encodeURIComponent(word)}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok && res.status !== 404) return { failed: true } as UpstreamBody
    return res.ok ? await res.json() : { entries: [] }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

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

type CedictRow = {
  simplified: string
  traditional: string
  pinyin: string
  glosses: string[]
}

/**
 * CC-CEDICT 에서 찾는다 — 간체·번체 둘 다 본다.
 *
 * lindera 가 합친 단어(北京大学)가 사전 항목과 같은 단위라 맞아떨어진다.
 * 필터를 두 번 나누는 이유: or() 안에 값을 직접 넣으면 따옴표·괄호가
 * 필터 문법을 깨뜨린다. 중국어에 그런 글자는 없지만, 없는 것을 가정하지 않는다.
 */
async function fetchCedict(
  client: ReturnType<typeof createServiceClient>,
  word: string,
): Promise<CedictRow[]> {
  const columns = 'simplified,traditional,pinyin,glosses'
  const bySimplified = await client.from('cc_cedict').select(columns).eq('simplified', word)
  if (bySimplified.error) throw new Error(`cc_cedict lookup failed: ${bySimplified.error.message}`)
  if ((bySimplified.data ?? []).length > 0) return bySimplified.data as CedictRow[]

  const byTraditional = await client.from('cc_cedict').select(columns).eq('traditional', word)
  if (byTraditional.error) throw new Error(`cc_cedict lookup failed: ${byTraditional.error.message}`)
  return (byTraditional.data ?? []) as CedictRow[]
}

/** CC-CEDICT 행 → 화면 섹션. 다독음자(和)는 읽는 법마다 섹션이 하나씩이다 */
function cedictSections(word: string, rows: CedictRow[]): Section[] {
  return rows.slice(0, MAX_CEDICT_READINGS).map((row) => ({
    form: word,
    role: 'surface' as const,
    phonetics: [pinyinToneMarks(row.pinyin)],
    parts: [
      {
        partOfSpeech: '',
        senses: row.glosses.slice(0, MAX_CEDICT_SENSES).map((definition) => ({
          definition,
          tags: [],
          examples: [],
        })),
      },
    ],
    source: { url: 'https://www.mdbg.net/chinese/dictionary', license: 'CC BY-SA 4.0', name: 'CC-CEDICT' },
  }))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  // 본문을 읽기 전에 걸러야 큰 요청이 파싱 비용을 쓰지 않는다
  if (bodyTooLarge(req)) return json({ error: 'request body too large' }, 413)

  try {
    let payload: { languageCode?: string; lemma?: string; surface?: string; targetLanguage?: string }
    try {
      payload = await req.json()
    } catch {
      return json({ error: 'invalid JSON body' }, 400)
    }

    const languageCode = payload.languageCode ?? ''
    const lemma = (payload.lemma ?? '').trim().toLowerCase()
    const surface = (payload.surface ?? '').trim()
    // 목표 언어 확장 대비 — 지금은 영어만 쓴다. CC-CEDICT 는 중영 전용이라
    // 다른 목표 언어의 중국어는 기존 경로(영어 뜻)로 간다.
    const targetLanguage = (payload.targetLanguage ?? 'en').trim().toLowerCase()

    if (!LANGUAGE_RE.test(languageCode)) return json({ error: 'invalid language code' }, 400)
    if (!/^[a-z]{2}$/.test(targetLanguage)) return json({ error: 'invalid target language' }, 400)
    if (lemma.length === 0) return json({ error: 'lemma is required' }, 400)
    if (lemma.length > MAX_LEMMA_CHARS) return json({ error: 'lemma too long' }, 400)
    if (surface.length > MAX_SURFACE_CHARS) return json({ error: 'surface too long' }, 400)
    // 공백이 섞이면 단어가 아니다 — 문장 조회로 남용되는 것을 막는다
    if (/\s/.test(lemma) || /\s/.test(surface)) {
      return json({ error: 'lemma must not contain whitespace' }, 400)
    }

    const client = createServiceClient()

    // 로그인을 강제하지 않는다 — 대신 설치 ID / IP / 전역 버킷으로 비용을 제한한다.
    // 하드 인증은 Release 5 의 제품 결정이라 여기서는 쿼터가 안전장치다.
    try {
      const limits = await makeQuotaLimits('dictionary', readInstallId(req), readClientIp(req))
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
      console.error('dictionary quota check failed', error)
      return json({ error: 'quota check unavailable' }, 503)
    }

    // 후보/원형어 조회가 겹쳐도 전체 시간을 넘기지 않게 한다
    const deadline = Date.now() + OVERALL_TIMEOUT_MS
    const checkDeadline = () => {
      if (Date.now() >= deadline) throw new DeadlineExceededError()
    }

    const { data: cached } = await client
      .from('dictionary_entries')
      .select('payload')
      .eq('language_code', languageCode)
      .eq('lemma', lemma)
      .eq('target_language', targetLanguage)
      .maybeSingle()

    if (cached) {
      const stored = cached.payload as Record<string, unknown>
      if (stored.schemaVersion === PAYLOAD_VERSION) return json({ ...stored, cached: true })
    }

    // 중국어 + 영어 뜻은 CC-CEDICT 자체 테이블을 본다 — 외부 API 쿼터가 없다
    if (languageCode === 'zh' && targetLanguage === 'en') {
      let rows: CedictRow[]
      try {
        rows = await fetchCedict(client, lemma)
      } catch {
        return json({ error: 'dictionary provider unreachable' }, 504)
      }
      const sections = cedictSections(lemma, rows)
      const withGloss = sections.filter((section) =>
        section.parts.some((part) => part.senses.length > 0),
      )
      const response = {
        schemaVersion: PAYLOAD_VERSION,
        found: withGloss.length > 0,
        lemma,
        languageCode,
        targetLanguage,
        matchedForm: null,
        sections,
        source: sections[0]?.source ?? null,
      }
      const { error: cacheError } = await client.from('dictionary_entries').upsert(
        {
          language_code: languageCode,
          lemma,
          target_language: targetLanguage,
          payload: response,
          provider: 'cc-cedict',
        },
        { onConflict: 'language_code,lemma,target_language' },
      )
      if (cacheError) console.error('dictionary cache insert failed', cacheError.message)
      return json({ ...response, cached: false })
    }

    // 대소문자와 활용형을 한 번에 처리한다 (forms 의 순서에 따라 탐색한다).
    //  1) 대소문자: 위 CAPITALIZES_NOUNS 참고
    //  2) 활용형: 본문은 속는다, 사전 항목은 속다
    // 대문자 보존이 필요한 언어가 아니면 표기도 소문자로 맞춰 조회한다.
    // 캐시 키가 소문자 lemma 이라 표기를 그대로 쓰면 Running(성) 과 running(동명사) 이
    // 같은 캐시 행을 공유해 엉뚱한 뜻이 남는다.
    const preservesCase = CAPITALIZES_NOUNS.has(languageCode.split('-')[0])
    const lookupSurface = preservesCase ? surface : surface.toLowerCase()
    const forms =
      lookupSurface && lookupSurface !== lemma ? [lookupSurface, lemma] : [lemma]
    const candidates = dedupeCandidates(
      forms.flatMap((form) => lookupCandidates(languageCode, form)),
    ).slice(0, MAX_CANDIDATES)

    // 성공한 항목은 모두 기억한다 — 표기는 첫 번째 후보라 표기 항목을 그대로 재사용한다
    const fetched = new Map<string, UpstreamBody>()
    for (const candidate of candidates) {
      checkDeadline()
      const body = await fetchUpstream(languageCode, candidate.word)
      if (body === null) return json({ error: 'dictionary provider unreachable' }, 504)
      if ((body as { failed?: boolean }).failed) {
        return json({ error: 'dictionary provider rejected the request' }, 502)
      }
      if (body.entries?.length) fetched.set(candidate.word, body)
    }

    const sections: Section[] = []

    const fetchHeadword = async (words: string[]): Promise<string | null> => {
      for (const word of words.slice(0, MAX_HEADWORDS)) {
        let body = fetched.get(word)
        if (!body) {
          checkDeadline()
          const fetchedBody = await fetchUpstream(languageCode, word)
          if (fetchedBody === null) return null
          if ((fetchedBody as { failed?: boolean }).failed || !fetchedBody.entries?.length) continue
          fetched.set(word, fetchedBody)
          body = fetchedBody
        }
        if (hasRealGloss(body.entries)) return word
      }
      return null
    }

    // ① 활용형 표기 자체의 항목 — 뜻이 있을 때만 별로 섹션을 만든다
    const surfaceBody = fetched.get(lookupSurface)
    const surfaceHasGloss = Boolean(surfaceBody && hasRealGloss(surfaceBody.entries))
    if (surfaceBody && surfaceHasGloss) sections.push(toSection(lookupSurface, 'surface', surfaceBody))

    if (surfaceHasGloss) {
      // ② 표기 항목의 뜻이 이미 원형어를 알려준다 — 그것을 따른다.
      //    활용형 후보를 고르는 방식은 오탐이 있다: en/running 의 후보 runn 은
      //    실제로 "인도의 모래·습지 지대" 라 다른 단어고, chang 은 중국 왕조다.
      //    조용히 틀린 뜻은 "기본형 없음"보다 나쁘다.
      const baseWord = await fetchHeadword(referencedHeadwords(surfaceBody?.entries.flatMap((e) => e.senses ?? [])))
      if (baseWord && baseWord !== lookupSurface) {
        sections.push(toSection(baseWord, 'base', fetched.get(baseWord)!))
      }
    } else {
      // ③ 표기 항목 자체가 없을 때만 활용형 후보를 믿는다 (ko 속는다 → 속다)
      const grammarOnly = [...fetched.values()].find((b) => !hasRealGloss(b.entries))
      const baseWord =
        (await fetchHeadword(referencedHeadwords(grammarOnly?.entries.flatMap((e) => e.senses ?? [])))) ??
        candidates.find((c) => c.via === 'inflection' && hasRealGloss(fetched.get(c.word)?.entries))
          ?.word ??
        null
      if (baseWord) sections.push(toSection(baseWord, 'base', fetched.get(baseWord)!))
    }

    // 표기가 곧 정답이고 기본형 항목도 없으면 표기 항목 하나만 둔다
    if (sections.length === 0 && surfaceBody) {
      sections.push(toSection(lookupSurface, 'surface', surfaceBody))
    }
    if (sections.length === 0 && lemma && fetched.get(lemma)) {
      sections.push(toSection(lemma, 'surface', fetched.get(lemma)!))
    }

    const withGloss = sections.filter((section) =>
      section.parts.some((part) => part.senses.length > 0),
    )

    const response = {
      schemaVersion: PAYLOAD_VERSION,
      found: withGloss.length > 0,
      lemma,
      languageCode,
      targetLanguage,
      /** 기본형으로 해석된 표기 (활용형 복원 또는 대소문자 복원) */
      matchedForm: sections.find((section) => section.role === 'base')?.form ?? null,
      sections,
      /** 섹션이 하나뿐이고 표기가 곧 정답이면 출처는 그 항목의 것을 쓴다 */
      source: sections[0]?.source ?? null,
    }

    // 음답도 캐시한다 — 위키낱말에 없는 단어를 반복 조회하지 않게
    const { error: cacheError } = await client.from('dictionary_entries').upsert(
      {
        language_code: languageCode,
        lemma,
        target_language: targetLanguage,
        payload: response,
        provider: 'freedictionaryapi.com',
      },
      { onConflict: 'language_code,lemma,target_language' },
    )
    if (cacheError) console.error('dictionary cache insert failed', cacheError.message)

    return json({ ...response, cached: false })
  } catch (error) {
    // 조회 데드라인은 서버 오류가 아니라 게이트웨이 시간 초과로 알린다
    if (error instanceof DeadlineExceededError) {
      return json({ error: 'dictionary lookup timed out' }, 504)
    }
    // 스택을 응답에 노출하지 않는다 — 내부 경로가 클라이언트에 새지 않게
    console.error('dictionary handler failed', error)
    return json({ error: 'internal error' }, 500)
  }
})