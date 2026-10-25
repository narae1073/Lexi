/** The Wordbook language survives leaving and returning through the top-level tabs. */

function sleep(ms = 250) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function run(ctx) {
  await ctx.enrollLanguage('English')
  await ctx.addLanguage('German')

  await ctx.clickSelector('a[href="/wordbook"]')
  await sleep(700)
  await ctx.waitFor(`!!document.querySelector('[data-wordbook-lang]')`, 'wordbook languages')

  const selectedGerman = await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('[data-wordbook-lang]')]
      .find(x => x.getAttribute('data-wordbook-lang') === 'de');
    if (!b) return false;
    b.click();
    return true;
  })()`)
  ctx.check('단어장에서 독일어를 고를 수 있다', selectedGerman === true)
  await sleep(400)

  const before = await ctx.page.evaluate(
    `document.querySelector('[data-wordbook-lang="de"]')?.getAttribute('aria-pressed')`,
  )
  ctx.check('독일어가 선택된 상태다', before === 'true', String(before))

  await ctx.clickSelector('a[href="/quiz"]')
  await sleep(500)
  await ctx.clickSelector('a[href="/wordbook"]')
  await sleep(700)
  await ctx.waitFor(`!!document.querySelector('[data-wordbook-lang]')`, 'wordbook languages again')

  const after = await ctx.page.evaluate(() => ({
    de: document.querySelector('[data-wordbook-lang="de"]')?.getAttribute('aria-pressed'),
    en: document.querySelector('[data-wordbook-lang="en"]')?.getAttribute('aria-pressed'),
  }))
  ctx.check(
    '탭을 오갔다 와도 독일어 선택이 유지된다',
    after.de === 'true' && after.en === 'false',
    JSON.stringify(after),
  )
}
