/**
 * 아래쪽 단어의 사전 박스가 로드되자마자 방향을 바꾸는지.
 *
 * 회귀: 박스 크기를 자식 요소로 재면 사전이 채워져도 다시 재지 않았다. 첫 측정은
 * 로딩 한 줄 높이이고, 그 높이면 아래에 들어간다고 판단한다. 내용이 차면서 아래로
 * 늘어나 화면 아래를 넘어간다. 닫았다 다시 열면 처음부터 내용이 있어 위로 오른다 —
 * 같은 사전이 두 번 다르게 놓인다.
 */

const TEXT = `The policy is written in a document.
Every policy needs a careful review of its wording.
A short policy is easier to remember.
The committee revised the policy last spring.
Nobody argued against the policy openly.
The policy was published without changes.
Some clauses in the policy remain unclear.
We should rewrite the policy carefully.
The policy applies to every employee.
A policy that nobody reads is useless.`

export async function run(ctx) {
  await ctx.enrollLanguage('English')
  await ctx.createDocument(TEXT)
  await sleep(2500)

  // 한 쪽에 다 담아 한 화면에서 본다 — 쪽을 넘기면 아래쪽 단어를 고르는 판이 복잡해진다
  await ctx.clickSelector('a[href="/"]')
  await sleep(600)
  await ctx.page.evaluate(`(() => {
    const link = [...document.querySelectorAll('a')].find(x => x.getAttribute('href')?.startsWith('/read/'));
    link.click();
    return true;
  })()`)
  await sleep(700)
  await ctx.waitFor(`!!document.querySelector('[data-start]')`, '본문')
  await ctx.page.evaluate(`(() => {
    const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => o.value === '500'));
    if (!s) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(s, '500');
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
  await sleep(600)

  // 본문 맨 끝 단어를 화면 아래로 밀어 넣는다 — 방향 문제가 생기는 자리다.
  // 이 단어는 문서 안에 한 번만 나온다 (clickWord 는 첫 매치를 누른다).
  const placed = await ctx.page.evaluate(`(() => {
    const el = [...document.querySelectorAll('[data-start]')].find(e => e.textContent === 'useless');
    if (!el) return null;
    el.scrollIntoView({ block: 'end' });
    const r = el.getBoundingClientRect();
    return { text: el.textContent, top: Math.round(r.top), viewportHeight: innerHeight };
  })()`)
  await sleep(400)
  ctx.check('아래쪽 단어를 화면 아래로 밀었다',
    Boolean(placed) && placed.top > placed.viewportHeight * 0.5,
    JSON.stringify(placed))

  await ctx.clickWord('useless')
  await sleep(500)
  ctx.check('단어를 눌러 박스가 떴다', Boolean(await ctx.popoverBox()), '단어 선택')

  // 사전 버튼을 누른다 — 이 순간엔 아직 내용이 없다
  const beforeLoad = await ctx.popoverBox()
  ctx.check('사전 버튼이 보인다', Boolean(beforeLoad), JSON.stringify(beforeLoad))
  await ctx.openDictionary()

  // 로딩 중에는 아래로 열려도 된다 — 아직 높이를 모른다
  await sleep(150)
  const during = await ctx.popoverBox()
  ctx.check('로딩 중 박스가 보인다', Boolean(during), JSON.stringify(during))

  // 사전이 도착하면 곧바로 방향을 바꿔야 한다 — 사용자가 다시 열어 볼 때까지 기다리지 않는다
  await ctx.waitFor(
    `(() => {
      const d = document.querySelector('[role="dialog"]');
      return !!d && /Wiktionary|CC BY|No entry|Loading/.test(d.innerText) && !/Loading/.test(d.innerText);
    })()`,
    '사전 도착',
    15000,
  )
  await sleep(500)

  const afterLoad = await ctx.popoverBox()
  ctx.check('사전이 온 뒤에도 뷰포트 안에 있다',
    afterLoad !== null && afterLoad.bottom <= afterLoad.viewportHeight + 1,
    JSON.stringify(afterLoad))
  ctx.check('사전이 온 뒤에도 위에서 떠 있다',
    afterLoad !== null && afterLoad.top >= 0,
    JSON.stringify(afterLoad))
  ctx.check('사전 내용으로 자랐다', afterLoad !== null && afterLoad.height > 100,
    JSON.stringify(afterLoad))

  // 방향이 위로 갔는지 — 앵커보다 위에 있어야 한다
  const flipped = await ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]').getBoundingClientRect();
    return { top: d.top, bottom: d.bottom, viewportHeight: innerHeight };
  })()`)
  ctx.check('사전 전체가 보인다', flipped.bottom <= flipped.viewportHeight + 1 && flipped.top >= 0,
    JSON.stringify(flipped))

  // ── 휴대전화에서도 같다 ──
  // 좁고 낮은 화면일수록 아래 여백이 모자란다 — 아래로 열리면 곧장 잘린다
  await ctx.setViewport(390, 740)
  await sleep(500)
  await ctx.page.evaluate(`(() => {
    const el = [...document.querySelectorAll('[data-start]')].find(e => e.textContent === 'careful');
    if (el) el.scrollIntoView({ block: 'end' });
    return true;
  })()`)
  await sleep(500)

  await ctx.clickWord('careful')
  await sleep(400)
  await ctx.openDictionary()
  await ctx.waitFor(
    `(() => {
      const d = document.querySelector('[role="dialog"]');
      return !!d && /Wiktionary|CC BY|No entry/.test(d.innerText);
    })()`,
    '사전 도착 (모바일)',
    15000,
  )
  await sleep(500)

  const mobile = await ctx.popoverBox()
  ctx.check('휴대전화에서도 사전 전체가 보인다',
    mobile !== null && mobile.bottom <= mobile.viewportHeight + 1 && mobile.top >= 0,
    JSON.stringify(mobile))
  ctx.check('가로로 넘치지 않는다', await ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]').getBoundingClientRect();
    return d.left >= 0 && d.right <= innerWidth + 1;
  })()`), JSON.stringify(mobile))
}

function sleep(ms = 400) {
  return new Promise((r) => setTimeout(r, ms))
}