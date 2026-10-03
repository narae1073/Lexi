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

  const plainColor = await colorOf(ctx, 'apple')
  await ctx.setStatus('New')
  const unknownColor = await colorOf(ctx, 'apple')
  ctx.check('● 선택 시 색이 바뀐다', plainColor !== unknownColor, `${plainColor} → ${unknownColor}`)
  await ctx.pressEscape()

  // 같은 표기가 반복된 다른 위치도 함께 칠해진다 (전역 상태)
  const appleColors = await ctx.page.evaluate(`(() => {
    const els = [...document.querySelectorAll('[data-start]')].filter(e => e.textContent === 'apple');
    return { count: els.length, distinct: new Set(els.map(e => getComputedStyle(e).color)).size };
  })()`)
  ctx.check('같은 단어의 모든 등장 위치가 함께 칠해진다', appleColors.count >= 1 && appleColors.distinct === 1,
    `${appleColors.count}곳`)

  // 아는 단어는 기본 색(본문색) — plan.txt 4줄
  await ctx.clickWord('busy')
  await sleep()
  await ctx.setStatus('Know')
  await ctx.pressEscape()
  const knownColor = await colorOf(ctx, 'busy')
  const unmarkedColor = await colorOf(ctx, 'busy')
  ctx.check('아는 단어는 표시되지 않은 단어와 같은 기본 색이다', knownColor === unmarkedColor,
    `${knownColor} vs ${unmarkedColor}`)

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
  ctx.check('새로고침 후 상태가 복원된다',
    afterReload.unknown !== afterReload.plain && afterReload.known === afterReload.plain,
    `모름=${afterReload.unknown} 앎=${afterReload.known}`)

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

function sleep() {
  return new Promise((r) => setTimeout(r, 400))
}