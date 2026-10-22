/** 간격 복습 — 기한이 된 앎 단어만 다시 나오고, 최근에 본 앎은 나오지 않는다 */

const TEXT = 'The alpha is here. The bravo is here.'

export async function run(ctx) {
  await ctx.enrollLanguage('English')
  await ctx.createDocument(TEXT, 'English')

  // ── 두 단어를 앎으로 표시한다 ──
  for (const word of ['alpha', 'bravo']) {
    await ctx.clickWord(word)
    await sleep(250)
    await ctx.setStatus('Know')
    await ctx.pressEscape()
    await sleep(150)
  }

  // ── 둘 다 방금 봤으므로 낼 것이 없다 — 앎은 기한이 되어야 나온다 ──
  await ctx.clickText('Quiz')
  await sleep(600)
  ctx.check('방금 앎으로 표시한 단어는 퀴즈에 나오지 않는다',
    (await body(ctx)).includes('Nothing to quiz yet'), await body(ctx))

  // ── alpha 의 마지막으로 본 시각을 30일 전으로 돌린다 ──
  const aged = await ctx.page.evaluate(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('lexi');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const rows = await new Promise((res, rej) => {
      const t = db.transaction('wordStates', 'readonly').objectStore('wordStates').getAll();
      t.onsuccess = () => res(t.result);
      t.onerror = () => rej(t.error);
    });
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await new Promise((res, rej) => {
      const tx = db.transaction('wordStates', 'readwrite');
      const store = tx.objectStore('wordStates');
      for (const row of rows) {
        if (row.lemma === 'alpha') store.put({ ...row, lastSeenAt: old });
      }
      tx.oncomplete = () => res(true);
      tx.onerror = () => rej(tx.error);
    });
    return rows.map((row) => row.lemma);
  })()`)
  ctx.check('단어 상태를 IndexedDB 에서 찾았다',
    aged.includes('alpha') && aged.includes('bravo'), JSON.stringify(aged))

  await ctx.reload()
  await sleep(1400)
  await ctx.clickText('Quiz')
  await sleep(600)

  // ── 기한이 된 alpha 만 재료다 — 최근에 본 bravo 는 빠진다 ──
  const sizes = await ctx.page.evaluate(
    `[...document.querySelectorAll('[data-quiz-size]')].map(b => b.getAttribute('data-quiz-size'))`,
  )
  ctx.check('기한이 된 앎 하나만 선택지에 있다', sizes.join(',') === '1', sizes.join(','))

  await ctx.page.evaluate(`(() => { document.querySelector('[data-quiz-start]').click(); return true })()`)
  await sleep(400)
  const cloze = await ctx.page.evaluate(`document.querySelector('[data-quiz-cloze]')?.innerText ?? null`)
  ctx.check('기한이 된 앎은 빈칸 문제로 나온다',
    typeof cloze === 'string' && cloze.includes('____'), String(cloze))
  ctx.check('답하기 전에는 단어를 보여 주지 않는다',
    (await ctx.page.evaluate(`!!document.querySelector('[data-quiz-word]')`)) === false)
  ctx.check('빈칸에 답이 새지 않는다',
    typeof cloze === 'string' && !cloze.includes('alpha'), String(cloze))
  ctx.check('오답을 만들 단어가 모자라면 세 단추로 돌아간다',
    (await ctx.page.evaluate(`!!document.querySelector('[data-quiz-choices-few]')`)) === true &&
    (await ctx.page.evaluate(`document.querySelectorAll('[data-quiz-choice]').length`)) === 0,
    await ctx.page.evaluate(`document.querySelector('[data-quiz-choices-few]')?.innerText ?? ''`))
  ctx.check('최근에 본 앎 단어는 나오지 않는다 — 한 문제뿐이다',
    (await ctx.page.evaluate(`document.querySelector('[data-quiz-progress]')?.innerText ?? ''`)).includes('1 / 1'),
    await ctx.page.evaluate(`document.querySelector('[data-quiz-progress]')?.innerText ?? ''`))

  // ── 모름으로 답하면 단어·뜻이 공개되고, 다시 학습 재료로 내려온다 ──
  await ctx.page.evaluate(`(() => { document.querySelector('[data-quiz-answer="unknown"]').click(); return true })()`)
  await sleep(300)
  ctx.check('답하면 단어가 공개된다',
    (await ctx.page.evaluate(`document.querySelector('[data-quiz-word]')?.innerText ?? null`)) === 'alpha',
    await ctx.page.evaluate(`document.querySelector('[data-quiz-word]')?.innerText ?? null`))
  ctx.check('답하면 뜻이 나온다',
    (await ctx.page.evaluate(`!!document.querySelector('[data-quiz-meaning]')`)) === true)
  await ctx.page.evaluate(`(() => { document.querySelector('[data-quiz-next]').click(); return true })()`)
  await sleep(400)

  const changes = await ctx.page.evaluate(`(() => {
    return [...document.querySelectorAll('[data-quiz-change]')].map(li =>
      [...li.querySelectorAll('[data-quiz-status]')].map(p => p.getAttribute('data-quiz-status'))
    );
  })()`)
  ctx.check('요약이 앎 → 모름을 보여 준다',
    JSON.stringify(changes) === JSON.stringify([['known', 'unknown']]), JSON.stringify(changes))
}

async function body(ctx) {
  return ctx.bodyText()
}

function sleep(ms = 300) {
  return new Promise((r) => setTimeout(r, ms))
}
