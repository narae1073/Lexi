/**
 * 단어 박스가 화면 아래 상태 바를 덮지 않는지.
 *
 * 상태 바는 fixed bottom-0 이고 z-20 이다. 자리 계산이 뷰포트 전체를 쓸 수 있는
 * 공간으로 보면 그 바를 덮는 자리가 나온다 — 바가 위에 그려지므로 박스 내용이 잘린
 * 것처럼 보인다. 아래쪽 여백에서 그 높이를 빼야 한다.
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

  // 상태 바가 있는지 먼저 확인한다 — 없으면 이 검사는 의미가 없다
  const bar = await ctx.page.evaluate(`(() => {
    const el = document.querySelector('[data-obstructs-bottom]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), height: Math.round(r.height), bottom: Math.round(r.bottom) };
  })()`)
  ctx.check('상태 바가 있다', Boolean(bar) && bar.height > 0, JSON.stringify(bar))

  /**
   * 화면 가운데 단어에 'policy' 의 사전처럼 긴 박스를 연다.
   *
   * 이게 실제로 깨지던 자리다. 상태 바를 빼지 않고 계산하면 아래 여백이 넉넉해
   * '아래' 로 열리고, 긴 박스가 그대로 상태 바를 덮는다 — 상태 바가 위에 그려지므로
   * 내용은 잘린 것처럼 보인다.
   */
  /**
   * 단어를 화면 정가운데에 딱 맞춘다 — 여기가 가장 아픈 자리다.
   *
   * 아래 여백이 '긴 박스' 와 '상태 바를 무시한 화면 끝' 사이에 들어야 아래로 열리면서
   * 상태 바만 덮는다. 대충 가운데로 보내면 어느 쪽으로든 떨어져 이 검사가 통과해 버린다.
   */
  const aimed = await ctx.page.evaluate(`(() => {
    // 화면 가운데로 옮길 수 있는 단어를 고르고, 옮기고, 표시까지 한 번에 한다.
    // 같은 표기가 여러 번 나올 수 있어 나중에 다시 찾는 방법은 위험하다.
    const target = innerHeight * 0.5;
    const words = [...document.querySelectorAll('[data-start]')];
    let best = null;
    let bestGap = Infinity;
    for (const el of words) {
      const gap = Math.abs(el.getBoundingClientRect().bottom - target);
      if (gap < bestGap) { bestGap = gap; best = el; }
    }
    if (!best) return null;

    for (let i = 0; i < 12; i++) {
      const delta = best.getBoundingClientRect().bottom - target;
      if (Math.abs(delta) < 2) break;
      const before = window.scrollY;
      window.scrollBy(0, delta);
      if (window.scrollY === before) break;
    }

    best.setAttribute('data-statusbar-target', '');
    return {
      text: best.textContent,
      bottom: Math.round(best.getBoundingClientRect().bottom),
      viewportHeight: innerHeight,
    };
  })()`)
  await sleep(500)
  ctx.check('단어를 화면 가운데에 맞췄다',
    aimed !== null && Math.abs(aimed.bottom - aimed.viewportHeight * 0.5) <= 12, JSON.stringify(aimed))
  if (!aimed) return

  await clickWordAt(ctx)
  await sleep(400)
  await ctx.openDictionary()
  await ctx.waitFor(
    `(() => {
      const d = document.querySelector('[role="dialog"]');
      return !!d && /Wiktionary|CC BY|No entry/.test(d.innerText);
    })()`,
    '사전 도착',
    15000,
  )
  await sleep(600)

  const box = await ctx.popoverBox()
  ctx.check('단어 박스가 떴다', Boolean(box), JSON.stringify(box))
  ctx.check('긴 박스가 확보된다', box !== null && box.height > 150, JSON.stringify(box))

  // 핵심: 박스가 상태 바 위에서 끝나야 한다
  const overlap = await ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]').getBoundingClientRect();
    const bar = document.querySelector('[data-obstructs-bottom]').getBoundingClientRect();
    return {
      boxBottom: Math.round(d.bottom),
      boxTop: Math.round(d.top),
      barTop: Math.round(bar.top),
      gap: Math.round(bar.top - d.bottom),
    };
  })()`)
  ctx.check('상태 바를 덮지 않는다', overlap.boxBottom <= overlap.barTop, JSON.stringify(overlap))
  ctx.check('사이에 간격이 있다', overlap.gap >= 0, JSON.stringify(overlap))

  // 위쪽 단어에서도 상태 바를 덮지 않아야 한다
  await ctx.page.evaluate(`(() => {
    const el = [...document.querySelectorAll('[data-start]')].find(e => e.textContent === 'document');
    if (el) el.scrollIntoView({ block: 'end' });
    return true;
  })()`)
  await sleep(400)
  await ctx.clickWord('document')
  await sleep(500)
  const other = await ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return null;
    const r = d.getBoundingClientRect();
    const bar = document.querySelector('[data-obstructs-bottom]').getBoundingClientRect();
    return { bottom: Math.round(r.bottom), top: Math.round(r.top), barTop: Math.round(bar.top) };
  })()`)
  ctx.check('다른 단어도 상태 바를 덮지 않는다',
    other === null || other.bottom <= other.barTop, JSON.stringify(other))

  // 상태 바의 줄 수를 늘려(좁은 화면) 높이가 커져도 지켜야 한다
  await ctx.setViewport(390, 740)
  await sleep(600)
  await ctx.page.evaluate(`(() => {
    const el = [...document.querySelectorAll('[data-start]')].find(e => e.textContent === 'clause');
    if (el) el.scrollIntoView({ block: 'end' });
    return true;
  })()`)
  await sleep(500)
  await ctx.clickWord('clause')
  await sleep(500)
  const narrow = await ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return null;
    const r = d.getBoundingClientRect();
    const bar = document.querySelector('[data-obstructs-bottom]').getBoundingClientRect();
    return {
      bottom: Math.round(r.bottom),
      top: Math.round(r.top),
      barTop: Math.round(bar.top),
      barHeight: Math.round(bar.height),
      viewportHeight: innerHeight,
    };
  })()`)
  ctx.check('좁은 화면에서도 상태 바를 덮지 않는다',
    narrow !== null && narrow.bottom <= narrow.barTop, JSON.stringify(narrow))
  ctx.check('좁은 화면에서도 화면을 넘지 않는다',
    narrow !== null && narrow.top >= 0 && narrow.bottom <= narrow.viewportHeight + 1, JSON.stringify(narrow))
}

/** data-statusbar-target 이 붙은 단어를 누른다 — 화면 위치를 직접 재서 */
async function clickWordAt(ctx) {
  const box = await ctx.page.evaluate(`(() => {
    const el = document.querySelector('[data-statusbar-target]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  if (!box) throw new Error('표시한 단어를 찾지 못함')
  for (const type of ['mousePressed', 'mouseReleased']) {
    await ctx.page.send('Input.dispatchMouseEvent', {
      type,
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    })
  }
  await sleep(300)
}

function sleep(ms = 400) {
  return new Promise((r) => setTimeout(r, ms))
}