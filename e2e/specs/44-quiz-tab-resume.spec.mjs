/**
 * Quiz session survives top-level tab switches.
 *
 * The quiz tabs are routes, so QuizView is unmounted when the user visits
 * Wordbook. Its session must therefore live outside the component.
 */

const WORDS = ['alpha', 'bravo', 'charlie']
const TEXT = WORDS.join(' ')

function sleep(ms = 250) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function quizState(ctx) {
  return ctx.page.evaluate(`(() => ({
    word: document.querySelector('[data-quiz-word]')?.innerText ?? null,
    progress: document.querySelector('[data-quiz-progress]')?.innerText ?? null,
    hasNext: !!document.querySelector('[data-quiz-next]'),
    hasMeaning: !!document.querySelector('[data-quiz-meaning]'),
    summary: !!document.querySelector('[data-quiz-summary]'),
  }))()`)
}

async function switchTab(ctx, path, readyExpression, label) {
  const clicked = await ctx.clickSelector(`a[href="${path}"]`)
  if (!clicked) throw new Error(`탭을 찾지 못했습니다: ${path}`)
  await ctx.waitFor(`location.pathname === ${JSON.stringify(path)}`, `${label} 경로`)
  await ctx.waitFor(readyExpression, label)
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

  const first = await quizState(ctx)
  ctx.check(
    '퀴즈가 첫 문제에서 시작한다',
    Boolean(first.word) && first.progress?.includes('1 / 3') === true,
    JSON.stringify(first),
  )

  // Answer but do not advance. A tab switch must restore the answer and Next.
  await ctx.page.evaluate(`(() => {
    document.querySelector('[data-quiz-answer="unknown"]')?.click();
    return true;
  })()`)
  await sleep(250)
  await switchTab(
    ctx,
    '/wordbook',
    `!!document.querySelector('input[placeholder]')`,
    'wordbook',
  )
  await switchTab(
    ctx,
    '/quiz',
    `!!document.querySelector('[data-quiz-word]')`,
    'resumed first quiz word',
  )

  const answered = await quizState(ctx)
  ctx.check(
    '탭을 오갔다 와도 같은 문제와 진도가 남는다',
    answered.word === first.word && answered.progress?.includes('1 / 3') === true,
    JSON.stringify(answered),
  )
  ctx.check(
    '답을 고른 뒤 탭을 오가도 답·뜻·다음 단추가 남는다',
    answered.hasNext && answered.hasMeaning,
    JSON.stringify(answered),
  )

  // Advance to question two, then leave and return.
  await ctx.page.evaluate(`document.querySelector('[data-quiz-next]')?.click(); true`)
  await sleep(250)
  const second = await quizState(ctx)
  await switchTab(
    ctx,
    '/wordbook',
    `!!document.querySelector('input[placeholder]')`,
    'wordbook',
  )
  await switchTab(
    ctx,
    '/quiz',
    `!!document.querySelector('[data-quiz-word]')`,
    'resumed second quiz word',
  )

  const secondResumed = await quizState(ctx)
  ctx.check(
    '다음 문제로 넘어간 뒤에도 같은 문제와 진도가 남는다',
    secondResumed.word === second.word &&
      secondResumed.progress?.includes('2 / 3') === true &&
      secondResumed.hasNext === false,
    JSON.stringify({ before: second, after: secondResumed }),
  )

  // Finish the session, then leave the summary and return.
  for (let index = 1; index < WORDS.length; index += 1) {
    await ctx.page.evaluate(`(() => {
      document.querySelector('[data-quiz-answer="unknown"]')?.click();
      return true;
    })()`)
    await sleep(200)
    await ctx.page.evaluate(`document.querySelector('[data-quiz-next]')?.click(); true`)
    await sleep(250)
  }
  await ctx.waitFor(`!!document.querySelector('[data-quiz-summary]')`, 'quiz summary')
  await switchTab(
    ctx,
    '/wordbook',
    `!!document.querySelector('input[placeholder]')`,
    'wordbook',
  )
  await switchTab(
    ctx,
    '/quiz',
    `!!document.querySelector('[data-quiz-summary]')`,
    'resumed quiz summary',
  )
  ctx.check('완료 화면도 탭을 오가면 그대로 남는다', (await quizState(ctx)).summary, 'summary')
}
