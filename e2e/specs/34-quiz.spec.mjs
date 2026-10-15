/** 단어 퀴즈 — 언어·개수 고르기, 단어 뽑기, 앎/헷갈림/모름, 사전, 다음, 끝난 화면 */

// 열두 개의 서로 다른 단어 — 모두 '모름' 으로 표시해 퀴즈 재료로 만든다
const WORDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot',
  'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima',
]
const TEXT = WORDS.join(' ')

export async function run(ctx) {
  await ctx.enrollLanguage('English')
  await ctx.createDocument(TEXT, 'English')

  // ── 열두 단어를 모두 '모름' 으로 표시한다 ──
  for (const word of WORDS) {
    await ctx.clickWord(word)
    await sleep(250)
    await ctx.setStatus('New')
    await ctx.pressEscape()
  }

  // ── 퀴즈 탭으로 ──
  await ctx.clickText('Quiz')
  await sleep(600)
  ctx.check('퀴즈 화면이 열린다', (await body(ctx)).includes('Word Quiz'), await body(ctx))

  // ── 언어 고르기 ──
  const hasLanguage = await ctx.page.evaluate(
    `!!document.querySelector('[data-quiz-language="en"]')`,
  )
  ctx.check('배운 언어를 고를 수 있다', hasLanguage === true, String(hasLanguage))

  // ── 개수 고르기 — 열두 개면 10 만 낼 수 있다 (20 은 재료가 없다) ──
  const sizes = await ctx.page.evaluate(
    `[...document.querySelectorAll('[data-quiz-size]')].map(b => b.getAttribute('data-quiz-size'))`,
  )
  ctx.check('개수 선택지가 10 뿐이다 (열두 개라서)', sizes.join(',') === '10', sizes.join(','))

  await ctx.page.evaluate(`(() => { document.querySelector('[data-quiz-size="10"]').click(); return true })()`)
  await sleep(200)
  await ctx.page.evaluate(`(() => { document.querySelector('[data-quiz-language="en"]').click(); return true })()`)
  await sleep(200)
  await ctx.page.evaluate(`(() => { document.querySelector('[data-quiz-start]').click(); return true })()`)
  await sleep(500)

  // ── 첫 단어 ──
  const firstWord = await ctx.page.evaluate(
    `document.querySelector('[data-quiz-word]')?.innerText ?? null`,
  )
  ctx.check('단어가 하나 나온다', typeof firstWord === 'string' && firstWord.length > 0, String(firstWord))
  ctx.check('진도가 1 / 10 이다',
    (await ctx.page.evaluate(`document.querySelector('[data-quiz-progress]')?.innerText ?? ''`)).includes('1 / 10'),
    await ctx.page.evaluate(`document.querySelector('[data-quiz-progress]')?.innerText ?? ''`))

  const answers = await ctx.page.evaluate(
    `[...document.querySelectorAll('[data-quiz-answer]')].map(b => b.getAttribute('data-quiz-answer'))`,
  )
  ctx.check('앎·헷갈림·모름 세 단추가 한 줄에 있다',
    answers.join(',') === 'known,unsure,unknown', answers.join(','))
  ctx.check('사전 단추가 있다',
    (await ctx.page.evaluate(`!!document.querySelector('[data-quiz-dictionary]')`)) === true)
  ctx.check('아직 다음 단추는 없다',
    (await ctx.page.evaluate(`!!document.querySelector('[data-quiz-next]')`)) === false)

  // ── 사전을 먼저 보면 '앎' 을 고를 수 없다 ──
  await ctx.page.evaluate(`(() => { document.querySelector('[data-quiz-dictionary]').click(); return true })()`)
  await sleep(500)
  ctx.check('사전 상자가 열린다',
    (await ctx.page.evaluate(`!!document.querySelector('[role="dialog"]')`)) === true)
  const knowDisabled = await ctx.page.evaluate(
    `document.querySelector('[data-quiz-answer="known"]')?.disabled ?? false`,
  )
  ctx.check('사전을 보면 앎 단추가 잠긴다', knowDisabled === true, String(knowDisabled))

  await ctx.pressEscape()
  await sleep(300)

  // ── 답하면 다음이 나타난다 ──
  await ctx.page.evaluate(`(() => { document.querySelector('[data-quiz-answer="unknown"]').click(); return true })()`)
  await sleep(300)
  ctx.check('답하면 다음 단추가 나타난다',
    (await ctx.page.evaluate(`!!document.querySelector('[data-quiz-next]')`)) === true)

  // 첫 단어를 넘긴다
  await ctx.page.evaluate(`(() => { document.querySelector('[data-quiz-next]').click(); return true })()`)
  await sleep(200)

  // ── 나머지 아홉 단어 — 모두 '앎' 을 누른다.
  //    모두 '모름' 이었으므로 규칙에 따라 '헷갈림' 이 되어야 한다 (한 번에 앎이 될 수 없다) ──
  for (let i = 0; i < 9; i++) {
    await ctx.page.evaluate(`(() => { document.querySelector('[data-quiz-answer="known"]').click(); return true })()`)
    await sleep(150)
    await ctx.page.evaluate(`(() => { document.querySelector('[data-quiz-next]').click(); return true })()`)
    await sleep(200)
  }

  // ── 끝난 화면 ──
  ctx.check('마치면 요약이 나온다',
    (await ctx.page.evaluate(`!!document.querySelector('[data-quiz-summary]')`)) === true)
  const counts = await ctx.page.evaluate(`(() => {
    const pick = (s) => document.querySelector('[data-quiz-count="' + s + '"]')?.innerText ?? null;
    return { known: pick('known'), unsure: pick('unsure'), unknown: pick('unknown') };
  })()`)
  ctx.check('모름에서 앎을 누른 단어는 헷갈림으로 센다', counts.unsure === '9',
    JSON.stringify(counts))
  ctx.check('그대로 모름으로 둔 단어는 하나다', counts.unknown === '1', JSON.stringify(counts))

  // ── 처음 화면으로 돌아간다 ──
  await ctx.page.evaluate(`(() => { document.querySelector('[data-quiz-again]').click(); return true })()`)
  await sleep(400)
  ctx.check('돌아가면 다시 언어를 고른다',
    (await ctx.page.evaluate(`!!document.querySelector('[data-quiz-language="en"]')`)) === true)
}

async function body(ctx) {
  return ctx.bodyText()
}

function sleep(ms = 400) {
  return new Promise((r) => setTimeout(r, ms))
}
