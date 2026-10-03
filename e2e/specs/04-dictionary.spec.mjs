/** 사전 조회 — 활용형·기본형·다항 품사 (plan.txt 3줄) */

const KO_TEXT = `나는 자주 속는다. 믿어야 한다.
Honesty is the best policy.`

export async function run(ctx) {
  await ctx.enrollLanguage('Korean')
  await ctx.createDocument(KO_TEXT, 'Korean')

  // 활용형 표기 → 기본형 항목이 함께 나온다
  await ctx.clickWord('속는다')
  await sleep()
  const ko = await ctx.openDictionary()
  ctx.check('한국어 활용형의 영어 정의가 나온다', /deceived|cheat/i.test(ko?.text ?? ''),
    ko?.text.replace(/\n/g, ' | ').slice(0, 130))
  ctx.check('기본형(속다) 항목이 표시된다', ko?.forms.includes('속다'), (ko?.forms ?? []).join(', '))
  ctx.check('IPA 발음이 보인다', /\d|\/|\[/.test(ko?.text ?? ''))
  ctx.check('출처(라이선스)가 표기된다', /Wiktionary/.test(ko?.text ?? ''))
  await ctx.pressEscape()

  // 항목이 없으면 알린다
  await ctx.clickWord('policy')
  await sleep()
  const miss = await ctx.openDictionary()
  ctx.check('한국어 사전에 없는 단어는 없다고 안내한다', /No entry/i.test(miss?.text ?? ''),
    miss?.text.replace(/\n/g, ' | ').slice(0, 90))
  await ctx.pressEscape()

  // 영어 문서에서는 영어 사전이 동작하고, 활용형이면 기본형까지 2개 섹션
  await ctx.clickSelector('a[href="/languages"]')
  await sleep(500)
  await ctx.addLanguage('English')
  await ctx.clickSelector('a[href="/compose"]')
  await sleep(600)
  await ctx.createDocument('Running daily is healthy. Studies show better results.', 'English')

  await ctx.clickWord('Running')
  await sleep()
  const running = await ctx.openDictionary()
  ctx.check('영어 활용형은 표기 + 기본형 2개 섹션', running?.sections === 2,
    `섹션 ${running?.sections} [${(running?.forms ?? []).join(', ')}]`)
  ctx.check('기본형 run 의 뜻이 나온다', /run/i.test(running?.text ?? ''),
    running?.text.replace(/\n/g, ' | ').slice(0, 130))
  await ctx.pressEscape()

  await ctx.clickWord('Studies')
  await sleep()
  const studies = await ctx.openDictionary()
  ctx.check('복수형 Studies → 기본형 study', studies?.sections === 2 && studies?.forms.includes('study'),
    `섹션 ${studies?.sections} [${(studies?.forms ?? []).join(', ')}]`)
  await ctx.pressEscape()

  // 다항 품사 — 같은 품사가 여러 항목으로 와도 전부 렌더된다 (React key 충돌 회귀)
  await ctx.clickWord('healthy')
  await sleep()
  await ctx.openDictionary()
  const posCount = await ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return 0;
    return [...d.querySelectorAll('p')].filter(p =>
      /^(noun|verb|adjective|adverb|adjective|pronoun|preposition|conjunction|interjection|determiner|numeral)$/i.test(p.innerText.trim())
    ).length;
  })()`)
  ctx.check('다항 품사가 사라지지 않는다', posCount >= 1, `품사 ${posCount}개`)

  // 팝오버가 화면을 넘지 않는다
  const box = await ctx.popover()
  const inViewport = await ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]').getBoundingClientRect();
    return d.top >= 0 && d.bottom <= innerHeight + 1;
  })()`)
  ctx.check('팝오버가 뷰포트 안에 머문다', inViewport === true, `${box?.width}px`)
}

function sleep() {
  return new Promise((r) => setTimeout(r, 400))
}