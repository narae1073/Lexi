/** 퀴즈 기본 개수 — 50 이 기본이다 (가진 단어가 50 이상일 때) */

/** 정확히 쉰 개의 서로 다른 단어 — 50 이 선택지에 들어가려면 50 개는 있어야 한다 */
const WORDS = Array.from({ length: 50 }, (_, i) => `w${i}`)
const TEXT = WORDS.join(' ')

export async function run(ctx) {
  await ctx.enrollLanguage('English')
  await ctx.createDocument(TEXT, 'English')

  // ── 쉰 단어를 모두 '모름' 으로 표시한다 — 퀴즈 재료 ──
  for (const word of WORDS) {
    await ctx.clickWord(word)
    await sleep(250)
    await ctx.setStatus('New')
    await ctx.pressEscape()
  }

  // ── 퀴즈 탭으로 ──
  await ctx.clickText('Quiz')
  await sleep(600)
  ctx.check('퀴즈 화면이 열린다', (await ctx.bodyText()).includes('Word Quiz'), 'Quiz')

  // 아직 고르지 않았을 때 골라져 있는 개수
  const pressedSize = () => ctx.page.evaluate(
    `[...document.querySelectorAll('[data-quiz-size]')].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.getAttribute('data-quiz-size')).join(',')`,
  )
  ctx.check('기본 개수가 50 이다', (await pressedSize()) === '50', await pressedSize())

  // 다른 개수를 고르면 그것으로 바뀐다
  await ctx.page.evaluate(`(() => { document.querySelector('[data-quiz-size="10"]').click(); return true })()`)
  await sleep(200)
  ctx.check('10 을 고르면 10 이 골라진다', (await pressedSize()) === '10', await pressedSize())
}

function sleep(ms = 400) {
  return new Promise((r) => setTimeout(r, ms))
}
