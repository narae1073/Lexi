/**
 * 메일 발신자 인증용 DNS 상태 확인 (PLAN.md §10.1).
 *
 * Resend 가 도메인을 추가하면 "이 레코드를 DNS 에 넣어라" 는 목록이 나온다.
 * 넣고 나서 전파까지 시간이 걸리고, 무엇을 빠뜨렸는지 매번 창을 오가며 확인한다.
 * 리전에 따라 값이 달라지므로 여기서 값을 단정하지 않고 — 존재하는지와
 * 실제 값이 무엇인지를 뽑아 보여 준다. Resend 화면의 값과 나란히 비교하면 된다.
 *
 * 사용: node e2e/verify-email-setup.mjs send.achijaser.date
 */

import { resolveCname, resolveMx, resolveTxt } from 'node:dns/promises'

const domain = process.argv[2] ?? 'send.achijaser.date'

const rows = []

async function txt(name) {
  try {
    return (await resolveTxt(name)).flat().join('')
  } catch {
    return null
  }
}

async function mx(name) {
  try {
    return (await resolveMx(name)).map((r) => `${r.priority} ${r.exchange}`).join(', ')
  } catch {
    return null
  }
}

async function cname(name) {
  try {
    return await resolveCname(name)
  } catch {
    return null
  }
}

async function check(label, name, value, hint) {
  rows.push({ label, name, value, hint, ok: value !== null && value !== '' })
}

console.log(`메일 발신자 도메인 확인  ${domain}\n`)

// Resend 가 붙이는 표준 레코드들
await check('SPF (TXT)', domain, await txt(domain), 'v=spf1 include:amazonses.com ~all')
await check('DKIM (CNAME)', `resend._domainkey.${domain}`, await cname(`resend._domainkey.${domain}`),
  'Resend 화면의 값과 나란히 비교')
await check('메일 발신 서버 (MX)', domain, await mx(domain), 'Resend 화면의 값과 나란히 비교')

// DKIM 이 TXT 로 붙는 경우도 있다 — 둘 중 하나만 있어도 된다
const dkimTxt = await txt(`resend._domainkey.${domain}`)
if (!rows[1].ok && dkimTxt) {
  rows[1] = { ...rows[1], value: dkimTxt, ok: true }
}

for (const row of rows) {
  const mark = row.ok ? 'PASS' : '아직 없음'
  console.log(`  ${mark.padEnd(7)} ${row.label}`)
  console.log(`          ${row.name}`)
  console.log(`          ${row.value ?? `(값 없음 — ${row.hint})`}`)
}

const missing = rows.filter((r) => !r.ok)
console.log('')
if (missing.length === 0) {
  console.log('세 레코트가 모두 확인된다. 이제 Resend 에서 상태가 Verified 인지 본다.')
  console.log('Supabase → Project Settings → Authentication → Email 에 SMTP 정보를 넣는다.')
} else {
  console.log(`${missing.length}건이 아직 없습니다.`)
  console.log('Cloudflare DNS 에 추가하고 전파를 기다린다. 보통 몇 분~몇십 분 걸린다.')
  console.log('확인이 끝났으면: node e2e/verify-email-setup.mjs ' + domain)
}
