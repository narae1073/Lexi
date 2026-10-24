/** End quiz now: keep only answered words and show the partial summary. */

const WORDS = ['alpha', 'bravo', 'charlie']
const TEXT = WORDS.join(' ')

function sleep(ms = 250) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function run(ctx) {
  await ctx.enrollLanguage('English')
  await ctx.createDocument(TEXT, 'English')

  for (const word of WORDS) {
    await ctx.clickWord(word)
    await sleep()
    await ctx.setStatus('New')
    await ctx.pressEscape()
  }

  await ctx.clickText('Quiz')
  await sleep(600)
  await ctx.waitFor(`!!document.querySelector('[data-quiz-start]')`, 'quiz setup')
  await ctx.page.evaluate(`(() => {
    document.querySelector('[data-quiz-language="en"]')?.click();
    document.querySelector('[data-quiz-size="3"]')?.click();
    document.querySelector('[data-quiz-start]')?.click();
    return true;
  })()`)
  await ctx.waitFor(`!!document.querySelector('[data-quiz-word]')`, 'first quiz word')

  await ctx.page.evaluate(`(() => {
    document.querySelector('[data-quiz-answer="unknown"]')?.click();
    return true;
  })()`)
  await sleep(250)
  await ctx.page.evaluate(`(() => {
    document.querySelector('[data-quiz-end-now]')?.click();
    return true;
  })()`)
  await ctx.waitFor(`!!document.querySelector('[data-quiz-summary]')`, 'partial quiz summary')

  const result = await ctx.page.evaluate(`(() => ({
    hint: document.querySelector('[data-quiz-summary-hint]')?.innerText ?? '',
    unknown: document.querySelector('[data-quiz-count="unknown"]')?.innerText ?? null,
    known: document.querySelector('[data-quiz-count="known"]')?.innerText ?? null,
    unsure: document.querySelector('[data-quiz-count="unsure"]')?.innerText ?? null,
    changes: document.querySelectorAll('[data-quiz-change]').length,
    hasQuestion: !!document.querySelector('[data-quiz-word]'),
    hasEndButton: !!document.querySelector('[data-quiz-end-now]'),
  }))()`)

  ctx.check(
    'End quiz now opens the completion screen immediately',
    result.hint.includes('1 of 3') && result.hasQuestion === false,
    JSON.stringify(result),
  )
  ctx.check(
    'The completion screen counts only the answer given so far',
    result.unknown === '1' && result.known === '0' && result.unsure === '0',
    JSON.stringify(result),
  )
  ctx.check(
    'The completed word list contains only the answered word',
    result.changes === 1,
    JSON.stringify(result),
  )
  ctx.check('The End quiz now button is gone on the summary', result.hasEndButton === false)

  await ctx.page.evaluate(`document.querySelector('[data-quiz-again]')?.click(); true`)
  await sleep(250)
  ctx.check(
    'Starting again returns to the setup screen',
    (await ctx.page.evaluate(`!!document.querySelector('[data-quiz-start]')`)) === true,
  )
}
