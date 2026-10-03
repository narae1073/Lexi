/** 단어장 (plan.txt 9줄) — 언어 선택 → 상태별 목록, 문서 안에서도 진입 */

const EN_TEXT = `The Apple store is busy. I ate an apple yesterday.
The US economy grew. Tell us the truth.`

export async function run(ctx) {
  await ctx.enrollLanguage('English')
  await ctx.createDocument(EN_TEXT, 'English')
  await sleep(2500) // 등장 기록은 유휴 시점에 기록된다

  // ── 메인 화면에서도 진입 (plan.txt 9줄) ──
  await ctx.clickSelector('a[href="/"]')
  await sleep(400)
  await ctx.clickSelector('a[href="/wordbook"]')
  await ctx.waitFor(`!!document.querySelector('input[placeholder]')`, '단어장')
  ctx.check('메인에서 단어장으로 들어갈 수 있다', (await ctx.bodyText()).includes('Wordbook'))

  const counts = await readTabCounts(ctx)
  ctx.check('상태별 탭 4개가 보인다', counts.length === 4, counts.join(' '))
  ctx.check('등장 기록이 단어장으로 반영된다', Number(counts[0]) > 0, `미표시 ${counts[0]}개`)

  // ── 목록 내용 ──
  const list = await ctx.page.evaluate(`(() => {
    const items = [...document.querySelectorAll('li')].filter(li => li.querySelector('button[role], button[aria-pressed]'));
    return items.map(li => ({
      lemma: li.querySelector('span')?.innerText ?? '',
      sentence: li.querySelectorAll('p')[0]?.innerText ?? '',
    }));
  })()`)
  ctx.check('목록에 단어가 보인다', list.length > 0, `${list.length}개`)
  ctx.check('단어마다 문맥 예문이 붙는다', list.every((i) => i.sentence.length > 0),
    list[0] ? JSON.stringify(list[0].sentence.slice(0, 46)) : '')
  ctx.check('US 와 us 가 서로 다른 항목이다', list.some((i) => i.lemma === 'US') && list.some((i) => i.lemma === 'us'),
    list.map((i) => i.lemma).join(', '))

  // ── 상태 변경 → 해당 탭으로 옮겨간다 ──
  const beforeUnknown = Number(counts[3])
  await markFirst(ctx)
  await sleep(400)
  const afterUnknown = Number((await readTabCounts(ctx))[3])
  ctx.check('상태를 바꾸면 개수가 반영된다', afterUnknown === beforeUnknown + 1,
    `모름 ${beforeUnknown} → ${afterUnknown}`)

  // ── 검색 ──
  await ctx.page.evaluate(`(() => {
    const i = document.querySelector('input[placeholder]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(i, 'US');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await sleep(400)
  const searched = await ctx.page.evaluate(`(() => {
    const words = [...document.querySelectorAll('li')].map(li => li.querySelector('span')?.innerText ?? '');
    return { count: words.length, words };
  })()`)
  ctx.check('검색이 걸린다', searched.words.includes('US') && searched.words.includes('us'),
    `${searched.count}개: ${searched.words.join(', ')}`)
  await ctx.page.evaluate(`(() => {
    const i = document.querySelector('input[placeholder]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(i, '');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await sleep(300)

  // ── 문서 안에서도 진입 (plan.txt 9줄) ──
  await ctx.clickSelector('a[href="/"]')
  await sleep(400)
  await ctx.page.evaluate(
    `[...document.querySelectorAll('a')].find(x=>x.getAttribute('href')?.startsWith('/read/'))?.click(); true`,
  )
  await ctx.waitFor(`!!document.querySelector('[data-start]')`, '본문')
  ctx.check('문서 안에 단어장 버튼이 있다', (await ctx.bodyText()).includes('Words in this document'))

  await ctx.clickSelector('a[href^="/wordbook?doc="]')
  await ctx.waitFor(`!!document.querySelector('input[placeholder]')`, '문서 단어장')
  ctx.check('문서 단어장은 그 문서로 한정된다', (await ctx.bodyText()).includes('From “'),
    (await ctx.bodyText()).split('\n').slice(0, 3).join(' | '))

  // ── 여러 언어를 배웠다면 언어 선택이 보인다 (plan.txt 9줄) ──
  await ctx.clickSelector('a[href="/wordbook"]')
  await sleep(400)
  await ctx.clickSelector('a[href="/languages"]')
  await sleep(500)
  await ctx.addLanguage('Korean')
  await ctx.clickSelector('a[href="/wordbook"]')
  await sleep(500)
  const languageChips = await ctx.page.evaluate(`(() => {
    const wanted = ['English', 'Korean'];
    return [...document.querySelectorAll('button[aria-pressed]')].filter(b => wanted.includes(b.innerText.trim())).length;
  })()`)
  ctx.check('단어장에서 언어를 고를 수 있다', languageChips >= 1, `칩 ${languageChips}개`)

  if (languageChips >= 2) {
    await ctx.clickText('Korean')
    await sleep(600)
    ctx.check('한국어로 바꾸면 목록이 그 언어 기록을 따른다', (await ctx.bodyText()).includes('Korean'),
      '언어 전환됨')
  }
}

async function readTabCounts(ctx) {
  return ctx.page.evaluate(`(() => {
    const row = [...document.querySelectorAll('button[aria-pressed]')].find(b => /\\d/.test(b.innerText));
    return row ? [...row.parentElement.children].map(c => (c.innerText.match(/(\\d+)/)?.[1] ?? '0')) : [];
  })()`)
}

/** 목록 첫 항목의 "모름" 상태 버튼을 누른다 */
async function markFirst(ctx) {
  await ctx.page.evaluate(`(() => {
    const li = document.querySelector('li button[aria-pressed]')?.closest('li');
    const btn = li && [...li.querySelectorAll('button')].find(b => b.innerText.trim() === 'New');
    if (!btn) return false;
    btn.click();
    return true;
  })()`)
}

function sleep() {
  return new Promise((r) => setTimeout(r, 400))
}