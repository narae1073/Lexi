/**
 * 중국어 형태소 분석 (lindera + CC-CEDICT).
 *
 * Intl.Segmenter 도 중국어는 곧잘 나누지만 고유명사와 합성어는 찢는다
 * (北京|大学). CC-CEDICT 는 사전 항목 단위라 학습 단위와 같다 — 北京大学,
 * 自然语言处理 가 한 단어다. 사전 조회도 그 항목으로 간다.
 *
 * 첫 실행은 사전(7MB)을 내려받아 OPFS 에 캐시하므로 시간이 걸린다 —
 * 그 사이엔 Intl 로 보인다. 두 번째부터는 캐시에서 바로 올라온다.
 */

const ZH_TEXT = `我昨天去北京大学了。
他把苹果吃了。`

export async function run(ctx) {
  await ctx.enrollLanguage('Chinese (Simplified)')
  await ctx.createDocument(ZH_TEXT, 'Chinese (Simplified)')
  await sleep(2500) // 등장 기록은 유휴 시점에 기록된다

  await ctx.clickSelector('a[href="/"]')
  await sleep(400)
  await ctx.page.evaluate(
    `[...document.querySelectorAll('a')].find(x=>x.getAttribute('href')?.startsWith('/read/'))?.click(); true`,
  )
  await ctx.waitFor(`!!document.querySelector('[data-start]')`, '본문')
  await sleep(500)

  // 처음엔 Intl 로 보인다 — 北京大学 이 하나로 묶이면 업그레이드된 것이다.
  // 첫 실행은 사전을 내려받으므로 generous 하게 기다린다.
  await ctx.waitFor(
    `!![...document.querySelectorAll('[data-start]')].find(e => e.textContent === '北京大学')`,
    'lindera 업그레이드',
    120_000,
  )
  const pieces = await ctx.page.evaluate(
    `[...document.querySelectorAll('[data-start]')].filter(e => /北京|大学/.test(e.textContent)).map(e => e.textContent)`,
  )
  ctx.check('北京大学 이 한 단어로 묶인다', pieces.includes('北京大学') && !pieces.includes('北京'),
    pieces.join(' | '))

  // 합친 단어에 상태를 주면 그대로 붙는다 — 중국어에 활용은 없다
  await ctx.clickWord('北京大学')
  await sleep()
  ctx.check('합친 단어를 누르면 팝오버가 열린다', (await ctx.popover()) !== null)
  await ctx.setStatus('Know')
  await ctx.pressEscape()

  // 단어장에는 표기 그대로 모인다. Know 표시를 했으므로 Know 탭에서 본다.
  await ctx.clickSelector('a[href="/wordbook"]')
  await ctx.waitFor(`!!document.querySelector('input[placeholder]')`, '단어장')
  await ctx.page.evaluate(`(() => {
    const row = [...document.querySelectorAll('button[aria-pressed]')].find(b => /\\d/.test(b.innerText));
    const tab = row && [...row.parentElement.children].find(c => /^Know it/.test(c.innerText.trim()));
    if (tab) tab.click();
    return true;
  })()`)
  const readLemmas = () => ctx.page.evaluate(`(() =>
    [...document.querySelectorAll('[data-wordbook-lemma]')].map(x => x.innerText))()`)
  let lemmas = []
  for (let i = 0; i < 30; i++) {
    await sleep(2000)
    lemmas = await readLemmas()
    if (lemmas.includes('北京大学')) break
  }
  ctx.check('단어장에 北京大学 가 있다', lemmas.includes('北京大学'), lemmas.join(', '))

  // 새로고침해도 업그레이드 상태다 — 사전은 OPFS 캐시에서 바로 올라온다
  await ctx.reload()
  await ctx.waitFor(`!!document.querySelector('a[href="/wordbook"]')`, '앱 재시작')
  await sleep(600)
  await ctx.clickSelector('a[href="/wordbook"]')
  await ctx.waitFor(`!!document.querySelector('input[placeholder]')`, '단어장')
  await ctx.page.evaluate(`(() => {
    const row = [...document.querySelectorAll('button[aria-pressed]')].find(b => /\\d/.test(b.innerText));
    const tab = row && [...row.parentElement.children].find(c => /^Know it/.test(c.innerText.trim()));
    if (tab) tab.click();
    return true;
  })()`)
  await ctx.waitFor(`!!document.querySelector('[data-wordbook-lemma="北京大学"]')`, '합치기 유지', 60_000)
  ctx.check('새로고침 후에도 하나로 묶인다',
    await ctx.page.evaluate(`!!document.querySelector('[data-wordbook-lemma="北京大学"]')`))
}

function sleep(ms = 400) {
  return new Promise((r) => setTimeout(r, ms))
}
