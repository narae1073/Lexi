/**
 * 모바일에서 문장 번역하기 (plan.txt 6줄).
 *
 * 회귀: 터치 기기에서 문장을 드래그해도 번역 창이 뜨지 않았다.
 * 터치 기기는 손을 떼는 순간 touchend 가 먼저 오는데 mouseup 만 듣고 있었다.
 *
 * 두 갈래를 모두 확인한다:
 *  1. 드래그(터치)로 고르는 길 — touchend 로도 반응하는가
 *  2. 단어 팝오버의 "이 문장 번역" — 드래그 없이 하는 길
 */

const TEXT = `Reading is the quiet habit that keeps a language alive.
The Apple store is busy today.`

/** 첫 문장 전체를 프로그램으로 골라, 어떤 이벤트를 쏘든 잡히게 만든다 */
const selectFirstSentence = (ctx) =>
  ctx.page.evaluate(`(() => {
    const first = [...document.querySelectorAll('[data-start]')].find(x => x.textContent === 'Reading');
    const last = [...document.querySelectorAll('[data-start]')].find(x => x.textContent === 'alive');
    if (!first || !last) return false;
    const range = document.createRange();
    range.setStartBefore(first);
    range.setEndAfter(last);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  })()`)

export async function run(ctx) {
  await ctx.enrollLanguage('English')
  await ctx.createDocument(TEXT, 'English')
  await ctx.page.evaluate(
    `[...document.querySelectorAll('a')].find(x=>x.getAttribute('href')?.startsWith('/read/'))?.click(); true`,
  )
  await ctx.waitFor(`!!document.querySelector('[data-start]')`, '본문')
  await sleep(500)

  // ── 1. 드래그로 고르는 길 ──
  await ctx.clickWord('quiet')
  await sleep()
  const wordBox = await ctx.popover()
  ctx.check('단어 팝오버가 먼저 열린다', Boolean(wordBox), `${wordBox?.width}px`)

  await ctx.pressEscape()
  await sleep(300)
  await ctx.page.evaluate(`getSelection()?.removeAllRanges(); true`)
  ctx.check('이전 선택을 먼저 비운다', !(await ctx.page.evaluate(`!!getSelection()?.toString()`)), '비어 있음')

  const selected = await selectFirstSentence(ctx)
  ctx.check('첫 문장을 고른다', selected === true, '범위 설정')

  // 손을 떼는 순간 touchend 가 먼저 온다
  await ctx.touchEnd('[data-start]')
  await ctx.waitFor(
    `(() => { const d = document.querySelector('[role="dialog"]'); return !!d })()`,
    '문장 팝오버', 15_000,
  )
  const byTouch = await ctx.popover()
  ctx.check('touchend 로도 문장 번역 창이 뜬다', Boolean(byTouch),
    (byTouch?.text ?? '').replace(/\n/g, ' | ').slice(0, 70))
  ctx.check('문장 박스가 단어 박스보다 넓다 (plan.txt 6줄)',
    (byTouch?.width ?? 0) > (wordBox?.width ?? 999),
    `문장 ${byTouch?.width}px vs 단어 ${wordBox?.width}px`)
  await ctx.pressEscape()

  // ── 1b. 스크롤로 넘어가면 touchend 대신 touchcancel 이 온다 ──
  await ctx.pressEscape()
  await ctx.page.evaluate(`getSelection()?.removeAllRanges(); true`)
  await sleep(300)
  await selectFirstSentence(ctx)
  await ctx.touchCancel('[data-start]')
  await ctx.waitFor(
    `(() => { const d = document.querySelector('[role="dialog"]'); return !!d })()`,
    '문장 팝오버 (touchcancel)', 15_000,
  )
  ctx.check('스크롤로 넘어가 touchcancel 이 와도 열린다', Boolean(await ctx.popover()), '열림')

  // ── 2. 드래그 없이 하는 길 ──
  await ctx.page.evaluate(`getSelection()?.removeAllRanges(); true`)
  await sleep(300)

  ctx.check('단어 팝오버에 "이 문장 번역" 이 있다',
    Boolean(wordBox?.buttons.find((b) => /문장 번역|Translate sentence/.test(b))),
    wordBox?.buttons.join(' | ') ?? '')

  await ctx.clickWord('habit')
  await sleep()
  const popover = await ctx.popover()
  ctx.check('단어를 눌러도 단어 팝오버가 뜬다', Boolean(popover), `${popover?.width}px`)

  await ctx.clickText('Translate sentence')
  await ctx.waitFor(
    `(() => { const d = document.querySelector('[role="dialog"]'); return !!d })()`,
    '문장 팝오버', 15_000,
  )
  const translated = await ctx.popover()
  ctx.check('버튼 하나로 문장 번역이 열린다', Boolean(translated),
    (translated?.text ?? '').replace(/\n/g, ' | ').slice(0, 70))

  // ── 3. 닫으면 원래 단어 팝오버로 돌아간다 ──
  await ctx.pressEscape()
  await sleep(400)
  const back = await ctx.popover()
  ctx.check('닫으면 단어 팝오버로 돌아온다',
    Boolean(back?.buttons.find((b) => /Dictionary|사전/.test(b))),
    back?.buttons.join(' | ') ?? '')

  // ── 4. 화면이 좁아도 문장 박스가 넘치지 않는다 ──
  await ctx.setViewport(360, 740)
  await sleep(400)
  const overflow = await ctx.page.evaluate(`document.documentElement.scrollWidth - window.innerWidth`)
  ctx.check('360px 에서 문장 박스가 가로로 넘치지 않는다', overflow <= 1, `넘침 ${overflow}px`)
}

function sleep() {
  return new Promise((r) => setTimeout(r, 400))
}
