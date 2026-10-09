/** 단어 상태 ○◐● 와 색상 (plan.txt 3·4줄) + 대소문자 충돌 분리 */

const TEXT = `The Apple store is busy. I ate an apple yesterday.
The US economy grew. The us in "tell us" differs from the country.`

export async function run(ctx) {
  await ctx.enrollLanguage('English')
  await ctx.createDocument(TEXT, 'English')

  ctx.check('단어 클릭 → 팝오버가 열린다', await ctx.clickWord('apple'))
  await sleep()
  const popover = await ctx.popover()
  ctx.check('○ ◐ ● 세 상태 버튼이 있다', Boolean(popover?.buttons.some((b) => b.includes('New'))), popover?.buttons.join(' '))
  ctx.check('사전 버튼이 있다', Boolean(popover?.buttons.some((b) => b.includes('Dictionary'))))

  // ── 즐겨찾기 ☆/★ — 제목 오른쪽, 상태와 독립 ──
  let star = await starState(ctx)
  ctx.check('제목 오른쪽에 빈 별이 있다', star?.star === '☆' && star?.pressed === 'false', JSON.stringify(star))
  ctx.check('별을 눌렀다', await clickStar(ctx))
  await sleep(300)
  star = await starState(ctx)
  ctx.check('별을 누르면 채워진다', star?.star === '★' && star?.pressed === 'true', JSON.stringify(star))
  await ctx.pressEscape()
  await ctx.clickWord('apple')
  await sleep()
  star = await starState(ctx)
  ctx.check('다시 열어도 별이 유지된다', star?.star === '★', JSON.stringify(star))
  // 팝오버를 열어 둔 채로 넘긴다 — 아래에서 상태를 바로 준다

  const unmarkedColor = await colorOf(ctx, 'apple')
  await ctx.setStatus('New')
  const unknownColor = await colorOf(ctx, 'apple')
  ctx.check('● 선택 시 색이 바뀐다', unmarkedColor !== unknownColor,
    `미표시 ${unmarkedColor} → ${unknownColor}`)
  await ctx.pressEscape()

  // 같은 표기가 반복된 다른 위치도 함께 칠해진다 (전역 상태)
  const appleColors = await ctx.page.evaluate(`(() => {
    const els = [...document.querySelectorAll('[data-start]')].filter(e => e.textContent === 'apple');
    return { count: els.length, distinct: new Set(els.map(e => getComputedStyle(e).color)).size };
  })()`)
  ctx.check('같은 단어의 모든 등장 위치가 함께 칠해진다', appleColors.count >= 1 && appleColors.distinct === 1,
    `${appleColors.count}곳`)

  // 아는 단어는 본문색 그대로(plan.txt 4줄), 표시 안 한 단어는 그보다 옅다
  await ctx.clickWord('busy')
  await sleep()
  await ctx.setStatus('Know')
  await ctx.pressEscape()
  const inkColor = await ctx.page.evaluate(`getComputedStyle(document.body).color`)
  const knownColor = await colorOf(ctx, 'busy')
  const untouchedColor = await colorOf(ctx, 'store')
  ctx.check('아는 단어는 본문색 그대로다', knownColor === inkColor, `${knownColor} vs 본문 ${inkColor}`)
  ctx.check('표시 안 한 단어는 아는 단어보다 옅다', untouchedColor !== knownColor,
    `미표시 ${untouchedColor} vs 알음 ${knownColor}`)

  // 대소문자 충돌: US 와 us 의 상태가 서로 독립여야 한다
  await ctx.clickWord('US')
  await sleep()
  await ctx.setStatus('New')
  await ctx.pressEscape()
  const usColors = { US: await colorOf(ctx, 'US'), us: await colorOf(ctx, 'us') }
  ctx.check('US 에 상태를 줘도 us 는 영향받지 않는다', usColors.US !== usColors.us,
    `US=${usColors.US} us=${usColors.us}`)

  // 새로고침 후에도 유지된다 (IndexedDB 영속)
  await ctx.goto()
  await sleep(800)
  await ctx.page.evaluate(
    `[...document.querySelectorAll('a')].find(x=>x.getAttribute('href')?.startsWith('/read/'))?.click(); true`,
  )
  await ctx.waitFor(`!!document.querySelector('[data-start]')`, '본문')
  await sleep(800)
  const afterReload = {
    unknown: await colorOf(ctx, 'apple'),
    known: await colorOf(ctx, 'busy'),
    plain: await colorOf(ctx, 'economy'),
  }
  const inkAfter = await ctx.page.evaluate(`getComputedStyle(document.body).color`)
  ctx.check('새로고침 후 상태가 복원된다',
    afterReload.unknown !== afterReload.plain && afterReload.known === inkAfter,
    `모름=${afterReload.unknown} 앎=${afterReload.known} 본문=${inkAfter}`)
  ctx.check('새로고침 후에도 표시 안 한 단어는 옅다',
    afterReload.plain !== afterReload.known,
    `미표시=${afterReload.plain} 앎=${afterReload.known}`)

  // 별도 새로고침 뒤에 살아 있어야 한다
  await ctx.clickWord('apple')
  await sleep()
  const starAfter = await starState(ctx)
  ctx.check('새로고침 후에도 별이 유지된다', starAfter?.star === '★', JSON.stringify(starAfter))
  await ctx.pressEscape()

  // 본문에 별 스티커가 붙는다 — 가상요소라 본문 텍스트는 그대로다
  const sticker = await ctx.page.evaluate(`(() => {
    const el = [...document.querySelectorAll('[data-start]')].find(e => e.textContent === 'apple');
    if (!el || !el.hasAttribute('data-favorite')) return null;
    const after = getComputedStyle(el, '::after');
    return { content: after.content, transform: after.transform, color: after.color };
  })()`)
  ctx.check('본문에 별 스티커가 붙는다',
    sticker !== null && (sticker.content ?? '').includes('★') && sticker.transform !== 'none',
    JSON.stringify(sticker))

  // ESC 로 닫는다
  await ctx.clickWord('economy')
  await sleep()
  ctx.check('다른 단어로 팝오버가 전환된다', (await ctx.popover()) !== null)
  await ctx.pressEscape()
  ctx.check('ESC 로 팝오버가 닫힌다', (await ctx.popover()) === null)
}

async function colorOf(ctx, surface) {
  return ctx.page.evaluate(`(() => {
    const el = [...document.querySelectorAll('[data-start]')].find(e => e.textContent === ${JSON.stringify(surface)});
    return el ? getComputedStyle(el).color : null;
  })()`)
}

/** 팝오버 제목 오른쪽의 별 버튼 상태 */
async function starState(ctx) {
  return ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const b = d && [...d.querySelectorAll('button')].find(x => x.innerText === '☆' || x.innerText === '★');
    return b ? { star: b.innerText, pressed: b.getAttribute('aria-pressed') } : null;
  })()`)
}

async function clickStar(ctx) {
  return ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const b = d && [...d.querySelectorAll('button')].find(x => x.innerText === '☆' || x.innerText === '★');
    if (!b) return false;
    b.click();
    return true;
  })()`)
}

function sleep() {
  return new Promise((r) => setTimeout(r, 400))
}