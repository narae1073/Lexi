/** 문장 드래그 선택 → 번역 (plan.txt 6줄) + 앱 언어 전환 */

const TEXT = `나는 매일 글을 읽습니다. 읽는 습관이 중요합니다.
Honesty is the best policy.`

export async function run(ctx) {
  await ctx.enrollLanguage('Korean')
  await ctx.createDocument(TEXT, 'Korean')

  // 단어 클릭은 단어 팝오버로 간다 (회귀)
  await ctx.clickWord('매일')
  await sleep()
  const wordPopover = await ctx.popover()
  ctx.check('단어 클릭 → 단어 팝오버', Boolean(wordPopover))
  // 사전 결과를 담기 위해 단어 박스는 300px 로 넓어졌다
  ctx.check('단어 박스는 300px 근처', wordPopover?.width >= 280 && wordPopover?.width <= 320, `${wordPopover?.width}px`)
  await ctx.pressEscape()

  // 문장 드래그 → 번역 팝오버
  await ctx.dragWords('나는', '습관이')
  await ctx.waitFor(
    `(() => { const d = document.querySelector('[role="dialog"]');
       return d && !d.innerText.includes('Translating'); })()`,
    '번역 완료', 25_000,
  )
  const sentence = await ctx.popover()
  ctx.check('드래그 → 문장 팝오버가 열린다', sentence !== null, sentence?.text.replace(/\n/g, ' | ').slice(0, 90))
  ctx.check('문장 박스가 단어 박스보다 넓다', (sentence?.width ?? 0) > 240, `${sentence?.width}px`)
  ctx.check('번역 결과가 영어로 나온다', /I read|reading|habit/i.test(sentence?.text ?? ''),
    sentence?.text.replace(/\n/g, ' | ').slice(0, 110))
  await ctx.pressEscape()

  // 앱 언어 전환 — 영어로
  await ctx.setAppLanguage('English', 'EN')
  const english = await ctx.bodyText()
  ctx.check('앱 언어가 영어로 바뀐다', /Add text|Languages|Settings/.test(english), english.split('\n').slice(0, 4).join(' | '))
  const htmlLang = await ctx.page.evaluate('document.documentElement.lang')
  ctx.check('<html lang> 도 바뀐다', htmlLang === 'en', `lang="${htmlLang}"`)

  // 영어 문서를 새로 만들면 영어→영어 번역은 identity 로 안내된다
  await ctx.clickSelector('a[href="/languages"]')
  await sleep(500)
  await ctx.addLanguage('English')
  await ctx.clickSelector('a[href="/compose"]')
  await sleep(600)
  await ctx.createDocument('Honesty is the best policy.', 'English')
  await ctx.dragWords('Honesty', 'policy')
  await ctx.waitFor(
    `(() => { const d = document.querySelector('[role="dialog"]');
       return d && !d.innerText.includes('Translating'); })()`,
    '번역 완료(en→en)', 25_000,
  )
  const identity = await ctx.popover()
  ctx.check('원문이 이미 영어면 번역하지 않고 알린다',
    /already in English/i.test(identity?.text ?? ''),
    identity?.text.replace(/\n/g, ' | ').slice(0, 100))

  // 한국어로 되돌린다
  await ctx.pressEscape()
  await ctx.setAppLanguage('한국어', 'KO')
  const korean = await ctx.bodyText()
  ctx.check('한국어로 되돌리면 한국어 UI 가 된다', /붙여넣기|설정|언어/.test(korean))
}

function sleep() {
  return new Promise((r) => setTimeout(r, 400))
}