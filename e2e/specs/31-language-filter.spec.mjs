/** 문서 목록의 언어 필터 — 섞인 목록을 한 언어로 좁히고, 전체로 돌아온다 */

const DE_TEXT = 'Das Haus ist groß und die Straße ist ruhig.'
const EN_TEXT = 'The house is big and the street is quiet.'

export async function run(ctx) {
  await ctx.enrollLanguage('German')
  await ctx.addLanguage('English')

  // ── 두 언어의 문서를 만든다 ──
  // 작성 화면은 배운 언어 중 첫 것(독일어)을 기본으로 깐다 — 영어는 칩을 직접 누른다
  await ctx.clickSelector('a[href="/"]')
  await sleep(500)
  await setTitle(ctx, 'Haus und Straße')
  await ctx.typeIntoTextarea(DE_TEXT)
  await ctx.clickText('Create document')
  await sleep(700)

  await ctx.clickSelector('a[href="/compose"]')
  await sleep(400)
  await clickLanguageChip(ctx, 'English')
  await setTitle(ctx, 'House and Street')
  await ctx.typeIntoTextarea(EN_TEXT)
  await ctx.clickText('Create document')
  await sleep(700)

  // ── 목록 화면 ──
  await ctx.clickSelector('a[href="/"]')
  await sleep(600)

  const dropdown = await dropdownOf(ctx)
  ctx.check('언어 드롭다운이 있다', dropdown !== null, JSON.stringify(dropdown))
  ctx.check(
    '문서가 있는 언어만 올린다 — 전체가 맨 앞이다',
    dropdown.options.length === 3 &&
      dropdown.options[0] === 'All languages' &&
      dropdown.options.some((o) => o.endsWith('English')) &&
      dropdown.options.some((o) => o.endsWith('German')),
    JSON.stringify(dropdown.options),
  )
  ctx.check('처음에는 전체다', dropdown.value === '', dropdown.value)
  const mixed = await titles(ctx)
  ctx.check('안 좁히면 두 언어가 섞여 보인다', mixed.en && mixed.de, JSON.stringify(mixed))

  // ── 영어만 ──
  await pickLanguage(ctx, 'English')
  await sleep(400)
  let rows = await titles(ctx)
  ctx.check('영어를 고르면 영어 문서만 남는다', rows.en && !rows.de, JSON.stringify(rows))

  // ── 독일어로 갈아탄다 ──
  await pickLanguage(ctx, 'German')
  await sleep(400)
  rows = await titles(ctx)
  ctx.check('독일어로 바꾸면 독일어 문서만 남는다', rows.de && !rows.en, JSON.stringify(rows))

  // ── 새로고침해도 고른 언어를 기억한다 ──
  await ctx.reload()
  await sleep(800)
  const after = await dropdownOf(ctx)
  ctx.check('새로고침해도 고른 언어가 남는다', after !== null && after.value === 'de', String(after?.value))
  rows = await titles(ctx)
  ctx.check('새로고침 뒤에도 독일어만 보인다', rows.de && !rows.en, JSON.stringify(rows))

  // ── 전체로 돌아온다 ──
  await pickLanguage(ctx, 'All languages')
  await sleep(400)
  rows = await titles(ctx)
  ctx.check('전체로 돌아오면 섞여 보인다', rows.en && rows.de, JSON.stringify(rows))

  // ── 한 언어뿐이면 드롭다운을 숨긴다 ──
  await pickLanguage(ctx, 'English')
  await sleep(300)
  const link = await ctx.page.evaluate(`(() => {
    const li = [...document.querySelectorAll('li')].find(x => /House and Street/.test(x.innerText));
    const a = li && li.querySelector('a[href^="/read/"]');
    if (a) a.click();
    return Boolean(a);
  })()`)
  await sleep(600)
  if (link) {
    await ctx.page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.innerText === 'Move to trash');
      if (b) b.click();
      return true;
    })()`)
    await sleep(400)
    // 한 번 묻는 상자를 확인해야 실제로 버려진다
    await ctx.page.evaluate(`(() => {
      const d = document.querySelector('[role="dialog"]');
      const b = d && [...d.querySelectorAll('button')].find(x => x.innerText === 'Move to trash');
      if (!b) return false;
      b.click();
      return true;
    })()`)
    await sleep(500)
  }
  await ctx.clickSelector('a[href="/"]')
  await sleep(600)
  const solo = await ctx.page.evaluate(`(() => {
    const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => /All languages/.test(o.textContent)));
    const rows = [...document.querySelectorAll('li')].map(li => li.innerText).join(' ');
    return { dropdown: Boolean(s), rows };
  })()`)
  ctx.check('한 언어뿐이면 드롭다운이 없다', solo.dropdown === false, JSON.stringify(solo.dropdown))
  ctx.check('숨겼을 때는 전체가 보인다', /Haus und Straße/.test(solo.rows) && !/House and Street/.test(solo.rows), solo.rows)

  // 뒷정리 — 영어 문서를 되살린다 (스펙 뒷부분의 근거를 되돌려 놓는다)
  await ctx.clickSelector('a[href="/trash"]')
  await sleep(500)
  await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /Restore/.test(x.innerText));
    if (b) b.click();
    return true;
  })()`)
  await sleep(400)
}

/** 언어 드롭다운 — '모든 언어' 옵션으로 찾는다 */
async function dropdownOf(ctx) {
  return ctx.page.evaluate(`(() => {
    const s = [...document.querySelectorAll('select')].find(x =>
      [...x.options].some(o => /All languages/.test(o.textContent)));
    if (!s) return null;
    return { options: [...s.options].map(o => o.textContent), value: s.value };
  })()`)
}

/** 목록의 문서 제목들 — 어떤 언어가 보이는지의 근거 */
function titles(ctx) {
  return ctx.page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('ul a[href^="/read/"]')].map(a => a.innerText);
    return { en: rows.some(r => /House and Street/.test(r)), de: rows.some(r => /Haus und Straße/.test(r)), rows };
  })()`)
}

/** 언어 드롭다운에서 옵션을 고른다 — 국기가 붙어도 찾는다 */
async function pickLanguage(ctx, label) {
  const ok = await ctx.page.evaluate(`(() => {
    const s = [...document.querySelectorAll('select')].find(x =>
      [...x.options].some(o => /All languages/.test(o.textContent)));
    if (!s) return false;
    const opt = [...s.options].find(o => o.textContent.includes(${JSON.stringify(label)}));
    if (!opt) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(s, opt.value);
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
  if (!ok) throw new Error(`언어 옵션을 못 찾음: ${label}`)
}

/** 작성 화면의 문서 언어 칩 */
async function clickLanguageChip(ctx, label) {
  const ok = await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.innerText.includes(${JSON.stringify(label)}));
    if (!b) return false;
    b.click();
    return true;
  })()`)
  if (!ok) throw new Error(`문서 언어 칩을 찾지 못함: ${label}`)
  await sleep(300)
}

/** 작성 화면의 제목 칸 */
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
