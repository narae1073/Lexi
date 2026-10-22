/**
 * RLS 실측 (PLAN.md 리스크 6).
 *
 * 정책 파일이 존재한다는 것만으로는 개인정보 유출을 막았다고 할 수 없다.
 * anon 키(= 빌드에 들어 있는 VITE_SUPABASE_ANON_KEY)로 사용자 테이블을 직접
 * 찔러보고, 아무것도 보이지 않는지 확인한다.
 *
 * 실행: node e2e/verify-rls.mjs
 * - .env.local 에 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 가 있어야 한다.
 * - 네트워크가 없으면 SKIP 으로 끝나고, 실패와 구분을 지킨다.
 */

import { readFileSync } from 'node:fs'

const ENV = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const env = Object.fromEntries(
  ENV.split('\n')
    .map((line) => line.replace(/^export\s+/, '').trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const at = line.indexOf('=')
      return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^["']|["']$/g, '')]
    }),
)

const URL_BASE = env.VITE_SUPABASE_URL
const ANON = env.VITE_SUPABASE_ANON_KEY

/** 사용자 데이터 — 절대 보이면 안 된다 */
const PRIVATE_TABLES = ['user_languages', 'documents', 'document_tombstones', 'word_states', 'word_occurrences']
/** 공유 캐시 — anon 읽기가 허용된다 */
const PUBLIC_TABLES = ['translation_cache', 'dictionary_entries']

let failures = 0

function report(ok, label, detail = '') {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

async function rest(table, extra = '') {
  const response = await fetch(`${URL_BASE}/rest/v1/${table}?select=*${extra}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
  })
  const text = await response.text()
  let rows
  try {
    rows = JSON.parse(text)
  } catch {
    return { status: response.status, rows: [] }
  }
  return { status: response.status, rows: Array.isArray(rows) ? rows : [] }
}

if (!URL_BASE || !ANON) {
  console.log('SKIP  .env.local 에 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 가 없습니다')
  process.exit(0)
}

let online = true
try {
  await fetch(`${URL_BASE}/rest/v1/`, {
    method: 'GET',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
    signal: AbortSignal.timeout(10_000),
  })
} catch {
  online = false
}

if (!online) {
  console.log('SKIP  네트워크에 닿지 못했습니다')
  process.exit(0)
}

console.log(`RLS 확인  ${URL_BASE}`)

// 1. 로그인하지 않은 상태로 사용자 데이터가 새어나가지 않는다
for (const table of PRIVATE_TABLES) {
  const { status, rows } = await rest(table)
  report(rows.length === 0, `${table}: anon 에게 보이는 행이 없다`,
    `http ${status}, ${rows.length}행`)
}

// 2. 쓰기도 막혀 있다 — policies 에 with check 가 없으면 insert 가 통과한다
for (const table of ['documents', 'word_states']) {
  const response = await fetch(`${URL_BASE}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${ANON}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(
      table === 'documents'
        ? { user_id: '00000000-0000-0000-0000-000000000000', language_code: 'en', raw_text: 'probe' }
        : { user_id: '00000000-0000-0000-0000-000000000000', language_code: 'en', lemma: 'probe' },
    ),
  })
  const inserted = response.status >= 200 && response.status < 300
  report(!inserted, `${table}: anon 이 쓰지 못한다`, `http ${response.status}`)

  // 혹시 들어갔으면 되돌린다 — 다른 사람 데이터에 쓰면 안 되므로 즉시 정리
  if (inserted) {
    await fetch(`${URL_BASE}/rest/v1/${table}?user_id=eq.00000000-0000-0000-0000-000000000000`, {
      method: 'DELETE',
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
    })
    console.log('        (위에서 들어간 행은 anon 으로 지울 수 없습니다 — 관리자가 확인해야 합니다)')
  }
}

// 3. 공유 캐시는 anon 읽기가 되어야 한다 — 막으면 사전·번역이 전부 죽는다
for (const table of PUBLIC_TABLES) {
  const { status } = await rest(table, '&limit=1')
  report(status === 200, `${table}: anon 읽기가 열린다`, `http ${status}`)
}

// 4. 다른 사람의 비밀 데이터가 새어나오지 않는다 — 임의의 jwt 로도 막혀야 한다
const forged = `${ANON.slice(0, 20)}.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJyb2xlIjoiYW5vbiJ9.`
const forgedRead = await fetch(`${URL_BASE}/rest/v1/documents?select=*&user_id=eq.00000000-0000-0000-0000-000000000000`, {
  headers: { apikey: ANON, Authorization: `Bearer ${forged}` },
})
const forgedText = await forgedRead.text()
let forgedRows = []
try {
  const parsed = JSON.parse(forgedText)
  forgedRows = Array.isArray(parsed) ? parsed : []
} catch {
  /* 본문이 JSON 이 아니면 0 행으로 본다 */
}
report(forgedRows.length === 0, 'documents: 조작한 jwt 로도 아무것도 안 보인다',
  `http ${forgedRead.status}, ${forgedRows.length}행`)

console.log(failures === 0 ? '\nRLS 확인 통과' : `\nRLS 확인 실패 ${failures}건`)
process.exit(failures === 0 ? 0 : 1)
