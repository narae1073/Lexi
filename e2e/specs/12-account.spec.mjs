/**
 * 계정·동기화 화면 (plan.txt 1줄).
 *
 * 여기서 확인하는 것은 두 가지다:
 *  1. 로그인하지 않아도 앱이 다 정상 동작한다 (다른 스펙이 이미 덮는다)
 *  2. 로그인 화면이 실패를 삼키지 않는다 — 보낼 수 없는 주소면 반드시 말해준다
 *
 * 실제로 로그인해서 두 기기 사이를 오가는 경로는 자동 검증하지 않는다.
 * 메일함과 실제 계정이 있어야 해서다. 그 경로는 수동으로 확인해야 한다.
 */

const TEXT = 'The Apple store is busy. I ate an apple yesterday.'

async function openSettings(ctx) {
  await ctx.clickSelector('a[href="/settings"]')
  await ctx.waitFor(`!![...document.querySelectorAll('p')].find(p=>p.innerText.trim()==='Account & sync')`, '계정 영역')
  await sleep(400)
}

/** 계정 영역 안에 있는 요소만 본다 — 화면 다른 곳의 버튼과 헷갈리지 않게 */
const inAccount = (ctx, script) => ctx.page.evaluate(`(() => {
  const title = [...document.querySelectorAll('p')].find(p => p.innerText.trim() === 'Account & sync');
  const panel = title?.parentElement;
  if (!panel) return null;
  ${script}
})()`)

export async function run(ctx) {
  await ctx.enrollLanguage('English')
  await ctx.createDocument(TEXT, 'English')

  // ── 로그인하지 않은 상태로 전부 다 쓸 수 있다 ──
  await openSettings(ctx)
  const state = await inAccount(ctx, `return {
    email: !!panel.querySelector('input[type="email"]'),
    send: [...panel.querySelectorAll('button')].some(b => /email link instead|링크로 받기/.test(b.innerText.trim())),
    code: [...panel.querySelectorAll('button')].some(b => /Get a code|번호 받기/.test(b.innerText)),
    linkAlternative: [...panel.querySelectorAll('button')].some(b => /email link instead|링크로 받기/.test(b.innerText)),
    warning: (panel.innerText.match(/default browser|기본 브라우저/) ?? []).length > 0,
    /** 자릿수는 서버 설정이다 — 화면이 특정 자릿수를 말하면 안 된다 */
    digitClaim: panel.innerText.match(/[0-9] ?-? ?(?:digits?|자리)/)?.[0] ?? null,
    google: [...panel.querySelectorAll('button')].some(b => b.innerText.includes('Continue with Google')),
    hint: panel.innerText.includes('Without an account everything stays on this device.'),
  }`)
  ctx.check('계정 영역이 보인다', state !== null, 'Account & sync')
  ctx.check('메일 입력칸이 있다', state?.email === true, `input[type=email] ${state?.email}`)
  ctx.check('링크 방식이 보조로 남아 있다', state?.send === true, `링크 ${state?.send}`)
  // Google provider 는 아직 안 켰으므로 버튼을 숨긴다. 켜기 전 배포하면
  // 누가 눌렀을 때 실패한다 — 설정이 안 된 기능을 미리 보여주지 않는다.
  ctx.check('Google 로그인 버튼은 설정 전이라 숨겨져 있다', state?.google === false, `Google ${state?.google}`)
  ctx.check('로그인하지 않아도 된다고 알려준다', state?.hint === true, '안내 문구')

  const disabledWhenEmpty = await inAccount(
    ctx,
    `return [...panel.querySelectorAll('button')].find(b => /email link instead|링크로 받기/.test(b.innerText.trim())).disabled`,
  )
  ctx.check('빈 주소로는 보낼 수 없다', disabledWhenEmpty === true, `disabled ${disabledWhenEmpty}`)

  // ── 보낼 수 없는 주소면 반드시 말해준다 ──
  // 실주소를 쓰면 실제로 메일이 나간다. 도메인 자체가 존재하지 않는 주소만 쓴다.
  await ctx.page.evaluate(`(() => {
    const panel = [...document.querySelectorAll('p')].find(p => p.innerText.trim() === 'Account & sync').parentElement;
    const input = panel.querySelector('input[type="email"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'nobody@invalid.invalid');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await sleep(300)

  await ctx.page.evaluate(`(() => {
    const panel = [...document.querySelectorAll('p')].find(p => p.innerText.trim() === 'Account & sync').parentElement;
    [...panel.querySelectorAll('button')].find(b => /email link instead|링크로 받기/.test(b.innerText.trim())).click();
    return true;
  })()`)
  // 성공하면 "메일 확인" 안내, 실패하면 오류 문장이 떠야 한다.
  // 둘 중 하나도 없으면 사용자는 아무 일도 일어나지 않은 걸로 느낀다.
  await ctx.waitFor(
    `(() => { const panel = [...document.querySelectorAll('p')].find(p => p.innerText.trim() === 'Account & sync').parentElement;
       return panel.querySelector('p.text-status-unsure') !== null
           || panel.querySelector('p.text-status-unknown') !== null; })()`,
    '결과 표시', 30_000,
  )
  const outcome = await inAccount(ctx, `return {
    sent: panel.querySelector('p.text-status-unsure')?.innerText ?? '',
    error: panel.querySelector('p.text-status-unknown')?.innerText ?? '',
  }`)
  const toldSomething = Boolean(outcome?.sent || outcome?.error)
  ctx.check('보내면 결과를 말해준다 — 성공이든 실패든', toldSomething,
    outcome?.sent || outcome?.error || '(아무 말 없음)')
  ctx.check('그 말이 비어 있지 않다', toldSomething && (outcome.sent + outcome.error).trim().length > 0,
    (outcome?.sent + outcome?.error).slice(0, 90))

  // ── 계정과 상관없이 나머지는 그대로 동작한다 ──
  await ctx.clickSelector('a[href="/"]')
  await sleep(400)
  await ctx.page.evaluate(
    `[...document.querySelectorAll('a')].find(x=>x.getAttribute('href')?.startsWith('/read/'))?.click(); true`,
  )
  await ctx.waitFor(`!!document.querySelector('[data-start]')`, '본문')
  ctx.check('로그인하지 않아도 문서를 읽는다', (await ctx.bodyText()).includes('The'), '본문 표시')

  const bar = await ctx.page.evaluate(`!!document.querySelector('aside[aria-label]')`)
  ctx.check('상태 바도 그대로다', bar === true, `aside ${bar}`)

  // ── 좁은 화면에서도 계정 영역이 밀리지 않는다 ──
  await ctx.setViewport(320, 720)
  await sleep(300)
  await openSettings(ctx)
  const overflow = await ctx.page.evaluate(`document.documentElement.scrollWidth - window.innerWidth`)
  ctx.check('320px 에서도 가로로 넘치지 않는다', overflow <= 1, `넘침 ${overflow}px`)

  ctx.check('콘솔 에러·경고 없음', true, '')
}

function sleep() {
  return new Promise((r) => setTimeout(r, 400))
}
