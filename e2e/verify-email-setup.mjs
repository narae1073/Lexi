/**
 * 메일 발신자 인증용 DNS 상태 확인 (PLAN.md §10.1).
 *
 * Resend 는 예전 방식(SPF TXT + MX)과 지금 방식(발송 CNAME 두 개 + DKIM TXT)을
 * 모두 안내한다. 실제로 붙는 건 Resend 화면에 표시된 그대로이므로,
 * 아래 이름들을 조회해 존재 여부와 실제 값을 뽑아 보여 준다.
 * 리전(Tokyo 등)에 따라 대상 값이 달라지므로 값을 단정하지 않는다 —
 * Resend 화면과 나란히 비교하면 된다.
 *
 * 사용: npm run verify:email -- send.achijaser.date
 */

import { resolveCname, resolveMx, resolveTxt } from 'node:dns/promises'

const domain = process.argv[2] ?? 'send.achijaser.date'

const short = (v) => (v && v.length > 58 ? `${v.slice(0, 58)}…` : v)

const dns = {
  async cname(name) {
    try {
      return await resolveCname(name)
    } catch {
      return null
    }
  },
  async txt(name) {
    try {
      return (await resolveTxt(name)).flat().join('')
    } catch {
      return null
    }
  },
  async mx(name) {
    try {
      return (await resolveMx(name)).map((r) => `${r.priority} ${r.exchange}`).join(', ')
    } catch {
      return null
    }
  },
}

/**
 * 레코드 하나를 조회한다.
 *
 * CNAME 을 걸면 DNS 는 그 이름의 뒤를 따라가므로, 같은 이름에서 TXT/MX 를 물어도
 * 대상 호스트의 값이 나온다. 그래서 아래에서 여러 종류를 함께 확인한다.
 */
async function inspect(name) {
  const [cn, tx, mx] = await Promise.all([dns.cname(name), dns.txt(name), dns.mx(name)])
  return { name, cname: cn, txt: tx, mx }
}

const dkim = await inspect(`resend._domainkey.${domain}`)
const sending = await inspect(`send.${domain}`)
const returnPath = await inspect(`resend.${domain}`)
const dmarc = await inspect(`_dmarc.${domain}`)

const rows = []

// 1. 서명 키 — 없으면 메일이 스팸으로 취급된다. 가장 중요하다
rows.push({
  label: '서명 키 DKIM',
  name: dkim.name,
  ok: Boolean(dkim.txt),
  value: dkim.txt ?? '(없음)',
  need: 'Resend 화면의 DKIM TXT 값',
})

// 2. 발송 경로 — CNAME 이 있다. 예전 방식이면 MX 로 대신한다
rows.push({
  label: '발송 경로',
  name: sending.name,
  ok: Boolean(sending.cname || sending.mx),
  value: sending.cname
    ? `CNAME → ${sending.cname}`
    : sending.mx
      ? `MX ${sending.mx} (예전 방식)`
      : '(없음)',
  need: `CNAME → Resend 화면의 값 (보통 send.forge.rmta.net)`,
})

// 3. 반환 경로 — 없어도 발송된다. 실패 통지(bounce)만 못 받는다.
//    막힌 것처럼 보이면 다음 단계로 못 갈 것처럼 보이므로 '권장' 으로 둔다
rows.push({
  label: '반환 경로 (bounce, 권장)',
  name: returnPath.name,
  ok: Boolean(returnPath.cname),
  optional: true,
  value: returnPath.cname
    ? `CNAME → ${returnPath.cname}`
    : '(없음 — 발송에는 영향 없음, bounce 통지만 못 받는다)',
  need: `CNAME → Resend 화면의 값 (보통 resend-*.forge.rmta.net)`,
})

// 4. DMARC — 선택 사항이다
rows.push({
  label: 'DMARC (선택)',
  name: dmarc.name,
  ok: true,
  optional: true,
  value: dmarc.txt ?? '(없음 — 없어도 발송된다)',
  need: 'v=DMARC1; p=none;',
})

console.log(`메일 발신자 도메인 확인  ${domain}\n`)
for (const row of rows) {
  const mark = row.ok ? (row.optional ? '있음 ' : 'PASS ') : '아직 없음'
  console.log(`  ${mark} ${row.label}`)
  console.log(`        ${row.name}`)
  console.log(`        ${short(row.value)}`)
  if (!row.ok) console.log(`        필요한 형태: ${row.need}`)
  console.log('')
}

const essential = rows.filter((r) => !r.optional)
const missing = essential.filter((r) => !r.ok)
const advised = rows.filter((r) => r.optional && !r.ok)

if (missing.length === 0) {
  console.log('발송에 필요한 레코드가 모두 확인된다.')
  if (advised.length > 0) {
    console.log(
      `참고로 ${advised.map((r) => r.label).join(', ')} 은(는) 아직 없습니다. 발송에는 영향이 없어서 다음 단계로 가도 됩니다.`,
    )
  }
  console.log('이제 Resend 화면의 상태가 Verified 인지 보고,')
  console.log('Supabase → Project Settings → Authentication → Email 에 SMTP 정보를 넣는다.')
  console.log('그리고 Authentication → URL Configuration 의 Redirect URLs 에')
  console.log('  http://localhost:5173/settings')
  console.log('  https://<앱 주소>/settings')
  console.log('를 직접 추가한다 — 안 넣으면 메일은 와도 링크가 깨진다.')
} else {
  console.log(`${missing.length}건이 아직 없습니다: ${missing.map((r) => r.label).join(', ')}`)
  console.log('Cloudflare DNS 에 추가하고 전파를 기다린다. 보통 몇 분 걸린다.')
  console.log('확인: npm run verify:email -- ' + domain)
}
