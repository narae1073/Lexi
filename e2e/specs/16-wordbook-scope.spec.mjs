/** 같은 언어 두 문서의 단어가 함께 쌓이는지 + 문서 드롭다운으로 좁히기 */

const DE_1 = `Das Haus ist groß und die Straße ist ruhig.
Ich gehe jeden Morgen früh zur Schule.`

const DE_2 = `Der Hund läuft schnell durch den Park.
Danach trinke ich Wasser mit einem Apfel.`

export async function run(ctx) {
  await ctx.enrollLanguage('German')

  // ── 첫 번째 독일어 문서 ──
  await ctx.page.evaluate(`(() => {
    const a = [...document.querySelectorAll('a')].find(x => x.getAttribute('href') === '/compose');
    a.click();
    return true;
  })()`)
  await sleep(400)
  await setTitle(ctx, 'Haus und Straße')
  await ctx.typeIntoTextarea(DE_1)
  await ctx.clickText('Create document')
  await sleep(700)

  // ── 두 번째 독일어 문서 ──
  await ctx.page.evaluate(`(() => {
    const a = [...document.querySelectorAll('a')].find(x => x.getAttribute('href') === '/compose');
    a.click();
    return true;
  })()`)
  await sleep(400)
  await setTitle(ctx, 'Hund im Park')
  await ctx.typeIntoTextarea(DE_2)
  await ctx.clickText('Create document')
  await sleep(700)

  // 두 번째 문서를 열어 본다 — 여기로서 '최근 본 문서 단어만 보인다' 는 버그가 났다
  await ctx.clickSelector('a[href="/"]')
  await sleep(700)
  ctx.check('두 문서가 목록에 있다', await ctx.page.evaluate(`(() => {
    const links = [...document.querySelectorAll('a')].filter(x => x.getAttribute('href')?.startsWith('/read/'));
    return links.length === 2;
  })()`), '링크 수 확인')

  await ctx.page.evaluate(`(() => {
    const li = [...document.querySelectorAll('li')].find(x => /Hund im Park/.test(x.innerText));
    li.querySelector('a[href^="/read/"]').click();
    return true;
  })()`)
  await sleep(800)
  ctx.check('문서를 열었다', (await ctx.bodyText()).includes('Hund'), JSON.stringify(await ctx.bodyText()))

  // 닫고 단어장으로 간다
  await ctx.clickSelector('a[href="/"]')
  await sleep(600)
  await ctx.page.evaluate(`(() => {
    const a = [...document.querySelectorAll('a')].find(x => x.getAttribute('href') === '/wordbook');
    a.click();
    return true;
  })()`)
  await sleep(800)

  // 처음 열리는 탭은 ★ — 미표시 목록을 보려면 탭을 눌러 간다
  await ctx.page.evaluate(`(() => {
    const row = [...document.querySelectorAll('button[aria-pressed]')].find(b => /\d/.test(b.innerText));
    const tab = row && [...row.parentElement.children].find(c => /^Not marked/.test(c.innerText.trim()));
    if (tab) tab.click();
    return true;
  })()`)
  await sleep(400)

  // ── 버그: 방금 연 문서 단어만 보인다 ──
  // 단어장 목록의 행만 본다 — 본문 전체로 보면 드롭다운의 옵션 제목이 섞여 읽는다
  const all = await ctx.page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('li')].map(li => li.innerText).join('\\n');
    return {
      fromFirst: /Haus/i.test(rows),
      fromSecond: /Hund/i.test(rows),
      rows: document.querySelectorAll('li').length,
    };
  })()`)
  ctx.check('첫 문서 단어도 보인다', all.fromFirst, JSON.stringify(all))
  ctx.check('방금 연 문서 단어도 보인다', all.fromSecond, JSON.stringify(all))
  ctx.check('두 문서의 단어가 함께 쌓인다', all.fromFirst && all.fromSecond, JSON.stringify(all))

  // ── 드롭다운으로 문서를 좁힌다 ──
  const scope = await ctx.page.evaluate(`(() => {
    const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => /Haus|Hund|전체|All documents/.test(o.textContent)));
    if (!s) return null;
    return { options: [...s.options].map(o => ({ value: o.value, text: o.textContent })), value: s.value };
  })()`)
  ctx.check('문서 드롭다운이 있다', Boolean(scope) && scope.options.length === 3, JSON.stringify(scope))

  const pick = await ctx.page.evaluate(`(() => {
    const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => /Haus|Hund|전체|All documents/.test(o.textContent)));
    if (!s) return false;
    const opt = [...s.options].find(o => /Hund im Park/.test(o.textContent));
    if (!opt) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(s, opt.value);
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
  ctx.check('문서를 고를 수 있다', pick === true, String(pick))
  await sleep(700)

  const scoped = await ctx.page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('li')].map(li => li.innerText).join('\\n');
    return {
      fromFirst: /Haus/i.test(rows),
      fromSecond: /Hund/i.test(rows),
      href: location.href,
    };
  })()`)
  ctx.check('고른 문서의 단어만 보인다', scoped.fromSecond && !scoped.fromFirst, JSON.stringify(scoped))
  const header = await ctx.page.evaluate(`document.querySelector('section header').innerText`)
  ctx.check('어느 문서인지 말한다', /Hund im Park/.test(header), JSON.stringify(header))
  ctx.check('주소에 범위가 남는다', /doc=/.test(scoped.href), scoped.href)

  // 다른 언어 문서로는 좁히지 않는다 — 빈 목록 대신 전체를 보여 준다
  await ctx.page.evaluate(`(() => {
    const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => /Haus|Hund|전체|All documents/.test(o.textContent)));
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(s, '');
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
  await sleep(600)
  const back = await ctx.page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('li')].map(li => li.innerText).join('\\n');
    return { fromFirst: /Haus/i.test(rows), fromSecond: /Hund/i.test(rows) };
  })()`)
  ctx.check('전체로 돌아오면 두 문서가 다시 보인다', back.fromFirst && back.fromSecond, JSON.stringify(back))

  // 새로고침해도 같은 범위가 유지된다
  await ctx.page.evaluate(`(() => {
    const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => /Haus|Hund|전체|All documents/.test(o.textContent)));
    const opt = [...s.options].find(o => /Haus und Straße/.test(o.textContent));
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(s, opt.value);
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
  await sleep(500)
  await ctx.page.evaluate(`location.reload(); true`)
  await sleep(1200)
  await ctx.waitFor(`!!document.querySelector('select')`, '단어장')
  const after = await ctx.page.evaluate(`(() => {
    const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => /Haus|Hund|전체|All documents/.test(o.textContent)));
    const rows = [...document.querySelectorAll('li')].map(li => li.innerText).join('\\n');
    return {
      value: s ? s.value : null,
      title: s ? [...s.options].find(o => o.value === s.value)?.textContent : null,
      fromSecond: /Hund/i.test(rows),
      fromFirst: /Haus/i.test(rows),
    };
  })()`)
  ctx.check('새로고침해도 범위가 유지된다', after.value !== '' && after.fromFirst && !after.fromSecond,
    JSON.stringify(after))
}

/** 작성 화면의 제목 칸 — 'Untitled' 여럿으로는 어느 문서인지 알 수 없다 */
async function setTitle(ctx, value) {
  await sleep(200)
  await ctx.page.evaluate(`(() => {
    const input = [...document.querySelectorAll('input')].find(x => !x.type || x.type === 'text');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
}

function sleep(ms = 400) {
  return new Promise((r) => setTimeout(r, ms))
}