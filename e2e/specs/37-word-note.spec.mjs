/** 단어 메모 — 읽기 팝오버에서 적고, 단어장과 퀴즈에서 다시 본다 */

const NOTE = 'first letter of the alphabet'

export async function run(ctx) {
  await ctx.enrollLanguage('English')
  await ctx.createDocument('The alpha is here.', 'English')

  // ── 단어를 눌러 메모를 적는다 ──
  await ctx.clickWord('alpha')
  await sleep(300)
  ctx.check('단어 팝오버에 메모 자리가 있다',
    (await ctx.page.evaluate(`!!document.querySelector('[data-word-note]')`)) === true)

  await ctx.typeIntoTextarea(NOTE)
  await ctx.waitFor(
    `(() => { const b = document.querySelector('[data-word-note-save]'); return !!b && !b.disabled })()`,
    '메모 저장 가능', 5_000,
  )
  await ctx.page.evaluate(`(() => { document.querySelector('[data-word-note-save]').click(); return true })()`)
  await sleep(300)
  ctx.check('저장하면 메모가 그 자리에 남는다',
    (await ctx.page.evaluate(`document.querySelector('[data-word-note]')?.value ?? null`)) === NOTE,
    await ctx.page.evaluate(`document.querySelector('[data-word-note]')?.value ?? null`))
  await ctx.pressEscape()
  await sleep(200)

  // ── 새로고침해도 남아 있고, 단어장에서 보인다 ──
  await ctx.reload()
  await ctx.waitFor(`!!document.querySelector('a[href="/wordbook"]')`, '앱 재시작')
  await sleep(600)
  await ctx.clickSelector('a[href="/wordbook"]')
  await ctx.waitFor(`!!document.querySelector('input[placeholder]')`, '단어장')
  await sleep(500)
  // 메모만 적어도 그 단어는 '헷갈림' 으로 들어온다 — 그 탭에서 찾는다
  await ctx.page.evaluate(`(() => {
    const tab = [...document.querySelectorAll('div.border-b button')]
      .find(b => /^Unsure/.test(b.innerText.trim()));
    if (tab) tab.click();
    return true;
  })()`)
  await sleep(300)
  const listed = await ctx.page.evaluate(
    `document.querySelector('[data-wordbook-note]')?.innerText ?? null`,
  )
  ctx.check('단어장에 메모가 보인다', listed === NOTE, String(listed))

  // ── 퀴즈에서도 답한 뒤에 다시 본다 ──
  await ctx.clickText('Quiz')
  await sleep(600)
  await ctx.page.evaluate(`(() => { document.querySelector('[data-quiz-start]').click(); return true })()`)
  await sleep(400)
  ctx.check('답하기 전에는 메모를 보여 주지 않는다',
    (await ctx.page.evaluate(`!!document.querySelector('[data-quiz-note]')`)) === false)
  await ctx.page.evaluate(`(() => { document.querySelector('[data-quiz-answer="unsure"]').click(); return true })()`)
  await sleep(300)
  ctx.check('답하면 메모가 다시 보인다',
    (await ctx.page.evaluate(`document.querySelector('[data-quiz-note]')?.innerText ?? ''`)).includes(NOTE),
    await ctx.page.evaluate(`document.querySelector('[data-quiz-note]')?.innerText ?? ''`))
}

function sleep(ms = 300) {
  return new Promise((r) => setTimeout(r, ms))
}
