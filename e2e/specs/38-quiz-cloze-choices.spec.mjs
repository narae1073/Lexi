/** 앎 단어 빈칸 복습 — 단어 선택지. 맞히면 앎, 틀리면 모름 */

const TEXT = 'The cat sat on the mat. The dog ran. The bird flew.'

export async function run(ctx) {
  await ctx.enrollLanguage('English')
  await ctx.createDocument(TEXT, 'English')

  // ── cat 만 앎으로 표시한다 — 나머지는 오답 후보로 남는다 ──
  await ctx.clickWord('cat')
  await sleep(250)
  await ctx.setStatus('Know')
  await ctx.pressEscape()
  await sleep(200)

  // ── cat 을 30일 전으로 돌리면 복습 기한이 된다 ──
  await ageWord(ctx, 'cat')
  await ctx.reload()
  await sleep(1400)
  await ctx.clickText('Quiz')
  await sleep(600)
  await ctx.page.evaluate(`(() => { document.querySelector('[data-quiz-start]').click(); return true })()`)
  await sleep(500)

  // ── 선택지 3개 — 뜻이 아니라 단어다 ──
  const choices = await ctx.page.evaluate(`(() => {
    return [...document.querySelectorAll('[data-quiz-choice]')].map(b => ({
      lemma: b.getAttribute('data-quiz-choice'),
      text: b.innerText.trim(),
    }));
  })()`)
  ctx.check('단어 선택지가 세 개 나온다', choices.length === 3, JSON.stringify(choices))
  ctx.check('정답 단어가 선택지에 있다',
    choices.some((c) => c.lemma === 'cat' && c.text === 'cat'), JSON.stringify(choices))
  ctx.check('선택지는 뜻이 아니라 단어다',
    choices.every((c) => c.text.length > 0 && !c.text.includes(' ')), JSON.stringify(choices))
  const clozeText = await ctx.page.evaluate(
    `document.querySelector('[data-quiz-cloze-text]')?.innerText ?? null`,
  )
  ctx.check('빈칸 문장이 단어를 숨긴다',
    typeof clozeText === 'string' && clozeText.includes('____') && !clozeText.includes('cat'),
    String(clozeText))

  // ── 정답을 고르면 앎으로 남는다 ──
  await ctx.page.evaluate(`(() => { document.querySelector('[data-quiz-choice="cat"]').click(); return true })()`)
  await sleep(400)
  ctx.check('맞히면 정답 표시가 나온다',
    (await ctx.page.evaluate(
      `document.querySelector('[data-quiz-choice-result]')?.getAttribute('data-quiz-choice-result') ?? null`,
    )) === 'correct')
  ctx.check('맞히면 단어가 공개된다',
    (await ctx.page.evaluate(`document.querySelector('[data-quiz-word]')?.innerText ?? null`)) === 'cat',
    await ctx.page.evaluate(`document.querySelector('[data-quiz-word]')?.innerText ?? null`))
  await ctx.page.evaluate(`(() => { document.querySelector('[data-quiz-next]').click(); return true })()`)
  await sleep(400)
  ctx.check('맞히면 앎 → 앎 이다',
    JSON.stringify(await readChanges(ctx)) === JSON.stringify([['known', 'known']]),
    JSON.stringify(await readChanges(ctx)))

  // ── 다시 30일 전으로 돌려 오답을 고른다 ──
  await ageWord(ctx, 'cat')
  await ctx.reload()
  await sleep(1400)
  await ctx.clickText('Quiz')
  await sleep(600)
  await ctx.page.evaluate(`(() => { document.querySelector('[data-quiz-start]').click(); return true })()`)
  await sleep(500)

  const wrongLemma = await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('[data-quiz-choice]')]
      .find(x => x.getAttribute('data-quiz-choice') !== 'cat');
    return b?.getAttribute('data-quiz-choice') ?? null;
  })()`)
  ctx.check('오답 선택지가 있다', typeof wrongLemma === 'string' && wrongLemma !== 'cat', String(wrongLemma))

  await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('[data-quiz-choice]')]
      .find(x => x.getAttribute('data-quiz-choice') !== 'cat');
    b.click();
    return true;
  })()`)
  await sleep(400)
  ctx.check('틀리면 오답 표시가 나온다',
    (await ctx.page.evaluate(
      `document.querySelector('[data-quiz-choice-result]')?.getAttribute('data-quiz-choice-result') ?? null`,
    )) === 'wrong')
  await ctx.page.evaluate(`(() => { document.querySelector('[data-quiz-next]').click(); return true })()`)
  await sleep(400)
  ctx.check('틀리면 앎 → 모름 이다',
    JSON.stringify(await readChanges(ctx)) === JSON.stringify([['known', 'unknown']]),
    JSON.stringify(await readChanges(ctx)))

  // ── 누른 결과가 횟수로 남는다: 앎 1, 모름 1 ──
  const presses = await ctx.page.evaluate(`(async () => {
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
    const cat = rows.find((r) => r.lemma === 'cat');
    return { known: cat?.knownPresses ?? 0, unknown: cat?.unknownPresses ?? 0 };
  })()`)
  ctx.check('맞힌 것은 앎 횟수로 센다', presses.known === 1, JSON.stringify(presses))
  ctx.check('틀린 것은 모름 횟수로 센다', presses.unknown === 1, JSON.stringify(presses))
}

async function readChanges(ctx) {
  return ctx.page.evaluate(`(() => {
    return [...document.querySelectorAll('[data-quiz-change]')].map(li =>
      [...li.querySelectorAll('[data-quiz-status]')].map(p => p.getAttribute('data-quiz-status'))
    );
  })()`)
}

/** 단어의 마지막으로 본 시각을 30일 전으로 돌린다 — 복습 기한을 만든다 */
async function ageWord(ctx, lemma) {
  return ctx.page.evaluate(`(async () => {
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
        if (row.lemma === ${JSON.stringify(lemma)}) store.put({ ...row, lastSeenAt: old });
      }
      tx.oncomplete = () => res(true);
      tx.onerror = () => rej(tx.error);
    });
    return true;
  })()`)
}

function sleep(ms = 300) {
  return new Promise((r) => setTimeout(r, ms))
}
