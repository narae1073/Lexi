/**
 * CC-CEDICT 덤프를 public.cc_cedict 에 적재한다.
 *
 * MDBG 공개 덤프(무료, CC BY-SA)를 직접 받아 파싱해 배치 upsert 한다.
 * 갱신도 같은 스크립트로 다시 돌린다 (같은 키는 덮어쓴다).
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run dict:load-zh
 *
 * service_role 키는 저장소에 넣지 않는다. RLS 가 anon 쓰기를 막으므로
 * 적재는 서비스 키로만 된다.
 */
import { gunzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

import { parseCedictLine } from '../supabase/functions/_shared/ccCedict.ts'

const URL = 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz'
const BATCH = 500

// CC_CEDICT_FILE 이 있으면 그 파일을 쓴다 — 다운로드를 막는 네트워크에서 적재할 때
const LOCAL_FILE = process.env.CC_CEDICT_FILE

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  throw new Error('SUPABASE_URL 과 SUPABASE_SERVICE_ROLE_KEY 가 필요하다')
}

console.log(`받는다: ${URL}`)
let gzipped
if (LOCAL_FILE) {
  console.log(`로컬 파일을 쓴다: ${LOCAL_FILE}`)
  gzipped = readFileSync(LOCAL_FILE)
} else {
  const response = await fetch(URL)
  if (!response.ok) throw new Error(`덤프 다운로드 실패: ${response.status}`)
  gzipped = Buffer.from(await response.arrayBuffer())
}
const text = gunzipSync(gzipped).toString('utf-8')

const rows = []
for (const line of text.split('\n')) {
  // 파서는 Edge Function 과 공용이다 — 넣는 것과 찾는 것이 어긋나지 않게
  const entry = parseCedictLine(line)
  if (entry) rows.push(entry)
}
console.log(`파싱: ${rows.length}행`)

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)
let done = 0
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH)
  const { error } = await supabase
    .from('cc_cedict')
    .upsert(batch, { onConflict: 'simplified,traditional,pinyin' })
  if (error) throw new Error(`적재 실패 @${i}: ${error.message}`)
  done += batch.length
  if (done % 10000 === 0 || done === rows.length) console.log(`적재: ${done}/${rows.length}`)
}
console.log('됐다')
