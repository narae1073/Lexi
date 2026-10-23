/**
 * 일본어 형태소 분석 (lindera + IPADIC).
 *
 * Intl.Segmenter 는 활용어를 어간과 어미로 찢는다 (食べた → 食|べた).
 * べた 는 어휘가 아니라 상태도 사전도 의미가 없고, 食べる 라는 단어는 어디에도
 * 나타나지 않는다. 형태소 분석기로 합치고 원형을 lemma 로 쓴다.
 *
 * 첫 실행은 사전(10MB)을 내려받아 OPFS 에 캐시하므로 시간이 걸린다 —
 * 그 사이엔 Intl 로 보인다. 두 번째부터는 캐시에서 바로 올라온다.
 */

const JA_TEXT = `昨日パンを食べた。今日も食べています。
関西国際空港で買ったお土産だ。`

export async function run(ctx) {
  // R3 makes dictionary downloads ask-by-default. This spec is about the
  // tokenizer, not the consent prompt: opt in before the document opens so a
  // native window.confirm() cannot block the CDP session.
  await ctx.page.evaluate(`localStorage.setItem('lexi.dictionary.autoDownload', 'true'); true`)
  await ctx.enrollLanguage('Japanese')
  await ctx.createDocument(JA_TEXT, 'Japanese')
  await sleep(2500) // 등장 기록은 유휴 시점에 기록된다

  await ctx.clickSelector('a[href="/"]')
  await sleep(400)
  await ctx.page.evaluate(
    `[...document.querySelectorAll('a')].find(x=>x.getAttribute('href')?.startsWith('/read/'))?.click(); true`,
  )
  await ctx.waitFor(`!!document.querySelector('[data-start]')`, '본문')
  await sleep(500)

  // 처음엔 Intl 로 보인다 — 食べた 이 하나로 묶이면 업그레이드된 것이다.
  // 첫 실행은 사전을 내려받으므로 generous 하게 기다린다.
  await ctx.waitFor(
    `!![...document.querySelectorAll('[data-start]')].find(e => e.textContent === '食べた')`,
    'lindera 업그레이드',
    120_000,
  )
  const pieces = await ctx.page.evaluate(
    `[...document.querySelectorAll('[data-start]')].filter(e => /食べ|べた/.test(e.textContent)).map(e => e.textContent)`,
  )
  ctx.check('食べた 이 한 단어로 묶인다', pieces.includes('食べた') && !pieces.includes('べた'),
    pieces.join(' | '))
  // 食べています → 食べて|います — 接続助詞 て 는 활용의 일부라 붙고,
  // いる+ます 는 います 로 합쳐진다
  const present = await ctx.page.evaluate(
    `[...document.querySelectorAll('[data-start]')].map(e => e.textContent)`,
  )
  ctx.check('食べています 가 食べて|います 로 묶인다',
    present.includes('食べて') && present.includes('います') && !present.includes('べ'),
    present.filter((w) => /べ|ます/.test(w)).join(' | '))

  // 합친 단어에 상태를 주면 원형(食べる)에 붙는다
  await ctx.clickWord('食べた')
  await sleep()
  ctx.check('합친 단어를 누르면 팝오버가 열린다', (await ctx.popover()) !== null)
  await ctx.setStatus('Know')
  await ctx.pressEscape()

  // 단어장에는 원형으로 모인다 — 食べた·食べています 가 食べる 하나다.
  // 食べる 는 Know 표시를 했으므로 Know 탭에서 본다.
  await ctx.clickSelector('a[href="/wordbook"]')
  await ctx.waitFor(`!!document.querySelector('input[placeholder]')`, '단어장')
  await ctx.page.evaluate(`(() => {
    const row = [...document.querySelectorAll('button[aria-pressed]')].find(b => /\\d/.test(b.innerText));
    const tab = row && [...row.parentElement.children].find(c => /^Know it/.test(c.innerText.trim()));
    if (tab) tab.click();
    return true;
  })()`)
  await sleep(1000)
  const readLemmas = () => ctx.page.evaluate(`(() =>
    [...document.querySelectorAll('[data-wordbook-lemma]')].map(x => x.innerText))()`)
  let lemmas = []
  for (let i = 0; i < 30; i++) {
    await sleep(2000)
    lemmas = await readLemmas()
    if (lemmas.includes('食べる')) break
  }
  const dump = await ctx.page.evaluate(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('lexi');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const getAll = (store) => new Promise((res, rej) => {
      const t = db.transaction(store, 'readonly').objectStore(store).getAll();
      t.onsuccess = () => res(t.result);
      t.onerror = () => rej(t.error);
    });
    return {
      occ: (await getAll('wordOccurrences')).map((o) => o.lemma + '/' + o.surfaces.join('+')),
      meta: await getAll('documentMeta').catch(() => 'no-store'),
    };
  })()`)
  ctx.check('단어장에 食べる 가 있다', lemmas.includes('食べる'),
    JSON.stringify({ lemmas, dump }))
  ctx.check('찢어진 조각(べた)이 단어장에 없다', !lemmas.includes('べた'), lemmas.join(', '))

  // 새로고침해도 업그레이드 상태다 — 사전은 OPFS 캐시에서 바로 올라온다.
  // 食べる 는 Know 표시를 했으므로 Know 탭에서 본다.
  await ctx.reload()
  await ctx.waitFor(`!!document.querySelector('a[href="/wordbook"]')`, '앱 재시작')
  await sleep(600)
  await ctx.clickSelector('a[href="/wordbook"]')
  await ctx.waitFor(`!!document.querySelector('input[placeholder]')`, '단어장')
  await ctx.page.evaluate(`(() => {
    const row = [...document.querySelectorAll('button[aria-pressed]')].find(b => /\\d/.test(b.innerText));
    const tab = row && [...row.parentElement.children].find(c => /^Know it/.test(c.innerText.trim()));
    if (tab) tab.click();
    return true;
  })()`)
  await ctx.waitFor(`!!document.querySelector('[data-wordbook-lemma="食べる"]')`, '원형 유지', 60_000)
  ctx.check('새로고침 후에도 원형으로 모인다',
    await ctx.page.evaluate(`!!document.querySelector('[data-wordbook-lemma="食べる"]')`))
}

function sleep(ms = 400) {
  return new Promise((r) => setTimeout(r, ms))
}
