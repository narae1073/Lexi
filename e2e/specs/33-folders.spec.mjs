/** 폴더(Phase 1) — 만들기, 문서를 옮기기, 지우면 문서가 돌아오기 */

const DE_TEXT = 'Das Haus ist groß und die Straße ist ruhig.'

export async function run(ctx) {
  await ctx.enrollLanguage('German')
  await ctx.createDocument(DE_TEXT, 'German')
  await ctx.clickSelector('a[href="/"]')
  await sleep(700)

  // ── 폴더 만들기 — 만들면 곧바로 그 폴더로 간다 ──
  await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.innerText.includes('New folder'));
    if (!b) throw new Error('새 폴더 단추 없음');
    b.click();
    return true;
  })()`)
  await sleep(300)
  const typed = await ctx.page.evaluate(`(() => {
    const input = document.querySelector('input[aria-label="Folder name"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Books');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`)
  ctx.check('폴더 이름을 짓는다', typed === true, String(typed))
  await sleep(500)

  ctx.check('만든 폴더가 곧바로 골라진다', /Books/.test((await chipTextOf(ctx, 'Books')) ?? ''), JSON.stringify((await ctx.bodyText()).slice(0, 300)))
  const empty = await ctx.page.evaluate(`(() =>
    [...document.querySelectorAll('p')].some(p => /No documents in this folder/.test(p.innerText)))()`)
  ctx.check('빈 폴더는 빈 폴더라고 말한다', empty === true, String(empty))

  // ── 문서를 폴더로 옮긴다 ──
  await pickChip(ctx, 'All documents')
  await sleep(300)
  await clickMove(ctx)
  await sleep(400)
  await pickOption(ctx, 'Books')
  await sleep(400)

  await pickChip(ctx, 'Books')
  await sleep(300)
  // 문서가 한 장이므로 셈이 곧 증거다 — 폴더가 좁혔는지가 목적이다
  ctx.check('폴더에 담긴 문서가 보인다', (await rowsCount(ctx)) === 1, await rows(ctx))

  // ── 새로고침 — 폴더와 담긴 문서가 남아 있다 ──
  await ctx.reload()
  await sleep(800)
  const chipAfter = await chipTextOf(ctx, 'Books')
  ctx.check('새로고침해도 폴더가 있다', /Books/.test(chipAfter ?? ''), chipAfter ?? '')
  await pickChip(ctx, 'Books')
  await sleep(300)
  ctx.check('새로고침해도 담긴 문서가 있다', (await rowsCount(ctx)) === 1, await rows(ctx))

  // ── 폴더를 지운다 — 문서는 폴더 없는 상태로 돌아온다 ──
  await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button[aria-label="Folder actions"]')].find(x =>
      x.closest('span')?.innerText.includes('Books'));
    if (!b) throw new Error('폴더 메뉴 없음');
    b.click();
    return true;
  })()`)
  await sleep(300)
  const deleted = await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('[role="dialog"] button')].find(x => x.innerText === 'Delete folder');
    if (!b) return false;
    b.click();
    return true;
  })()`)
  ctx.check('폴더를 지울 수 있다', deleted === true, String(deleted))
  await sleep(500)

  const chipsAfter = await ctx.page.evaluate(`(() => {
    const row = [...document.querySelectorAll('div')].find(d => d.innerText.startsWith('All documents'));
    return row ? row.innerText : '';
  })()`)
  ctx.check('지운 폴더는 칩에서 사라진다', !/Books/.test(chipsAfter), chipsAfter)
  // 문서가 한 장이고 좁혀이 풀렸으므로, 줄 하나가 '돌아온 것'의 증거다
  ctx.check('지운 폴더의 문서는 전체 목록으로 돌아온다', (await rowsCount(ctx)) === 1, await rows(ctx))
}

/** 칩의 텍스트 — 이름으로 찾는다 (눌려 있는 칩은 ⋯ 메뉴 단추를 갖고 있다) */
async function chipTextOf(ctx, label) {
  return ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.innerText.includes(${JSON.stringify(label)}));
    return b ? b.innerText : null;
  })()`)
}

async function pickChip(ctx, label) {
  const ok = await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.innerText.includes(${JSON.stringify(label)}));
    if (!b) return false;
    b.click();
    return true;
  })()`)
  if (!ok) throw new Error(`칩을 찾지 못함: ${label}`)
}

async function clickMove(ctx) {
  const ok = await ctx.page.evaluate(`(() => {
    const b = document.querySelector('button[aria-label="Move to folder"]');
    if (!b) return false;
    b.click();
    return true;
  })()`)
  if (!ok) throw new Error('옮기기 단추 없음')
}

async function pickOption(ctx, label) {
  const ok = await ctx.page.evaluate(`(() => {
    const o = [...document.querySelectorAll('[role="option"]')].find(x => x.innerText.includes(${JSON.stringify(label)}));
    if (!o) return false;
    o.click();
    return true;
  })()`)
  if (!ok) throw new Error(`옮길 폴더 옵션을 찾지 못함: ${label}`)
}

async function rows(ctx) {
  return ctx.page.evaluate(`(() =>
    [...document.querySelectorAll('ul a[href^="/read/"]')].map(a => a.innerText).join(' '))()`)
}

function rowsCount(ctx) {
  return ctx.page.evaluate(`document.querySelectorAll('ul a[href^="/read/"]').length`)
}

function sleep(ms = 400) {
  return new Promise((r) => setTimeout(r, ms))
}
