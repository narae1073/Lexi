/** 폴더 탐색 — 만들기, 들어가기·뒤로, 골라 담아 옮기기·버리기, 지우면 돌아오기 */

const DE_TEXT = 'Das Haus ist groß und die Straße ist ruhig.'

export async function run(ctx) {
  await ctx.enrollLanguage('German')
  await ctx.createDocument(DE_TEXT, 'German')
  await ctx.clickSelector('a[href="/"]')
  await sleep(700)

  // ── 폴더 만들기 — 만들면 곧바로 그 안으로 들어간다 ──
  await clickButtonIncludes(ctx, 'New folder')
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

  ctx.check('만든 폴더 안으로 들어간다', (await body(ctx)).includes('Books'), '')
  const empty = await ctx.page.evaluate(`(() =>
    [...document.querySelectorAll('p')].some(p => /No documents in this folder/.test(p.innerText)))()`)
  ctx.check('빈 폴더는 빈 폴더라고 말한다 (벗어날 길과 함께)', empty === true, String(empty))
  const backVisible = await ctx.page.evaluate(
    `!!document.querySelector('button[aria-label="Back"]')`,
  )
  ctx.check('폴더 안에서는 뒤로 단추가 있다', backVisible === true, String(backVisible))

  // ── 뒤로 — 뿌리로 나온다 ──
  await clickBack(ctx)
  await sleep(400)
  ctx.check('뿌리는 전체 문서다', (await body(ctx)).includes('All documents'), '')
  ctx.check('뿌리에 폴더 줄이 있다', await folderRowExists(ctx, 'Books'), await body(ctx))
  ctx.check('옮기기 전에는 문서가 뿌리에 있다', (await docRowsCount(ctx)) === 1, await rows(ctx))

  // ── 골라 담아 폴더로 옮긴다 ──
  await clickExact(ctx, 'Select documents')
  await sleep(300)
  // 제목을 짓지 않은 문서는 'Untitled' 다 (createDocument 는 제목을 비운다)
  await tickRow(ctx, 'Untitled')
  await sleep(300)
  ctx.check('고른 셈이 보인다', (await body(ctx)).includes('1 selected'), '')
  await clickExact(ctx, 'Move selected to a folder')
  await sleep(400)
  await pickOption(ctx, 'Books')
  await sleep(500)

  ctx.check('옮기고 나면 고르기가 끝난다', !(await body(ctx)).includes('selected'), '')
  ctx.check('뿌리에서 문서는 사라진다', (await docRowsCount(ctx)) === 0, await rows(ctx))
  await enterFolder(ctx, 'Books')
  await sleep(400)
  ctx.check('폴더 안에 담긴 문서가 보인다', (await docRowsCount(ctx)) === 1, await rows(ctx))

  // ── 새로고침 — 폴더와 담긴 문서는 남고, 자리는 뿌리로 돌아간다 ──
  await ctx.reload()
  await sleep(800)
  ctx.check('새로고침해도 폴더가 있다', await folderRowExists(ctx, 'Books'), '')
  ctx.check('새로고침하면 자리는 뿌리다 (앱 안의 상태)', (await body(ctx)).includes('All documents'), '')
  await enterFolder(ctx, 'Books')
  await sleep(300)
  ctx.check('새로고침해도 담긴 문서가 있다', (await docRowsCount(ctx)) === 1, await rows(ctx))

  // ── 중첩 — 하위 폴더를 만들고 들어가고 나온다 ──
  await clickButtonIncludes(ctx, 'New subfolder')
  await sleep(300)
  await ctx.page.evaluate(`(() => {
    const input = document.querySelector('input[aria-label="Folder name"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Short');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`)
  await sleep(500)
  ctx.check('하위 폴더 안으로 들어간다', (await body(ctx)).includes('Short'), '')
  await clickBack(ctx)
  await sleep(400)
  ctx.check('한 단계 위로 나온다', (await body(ctx)).includes('Books'), '')
  ctx.check('하위 폴더 줄이 보인다', await folderRowExists(ctx, 'Short'), '')
  await clickBack(ctx)
  await sleep(400)
  ctx.check('뿌리로 나온다', (await body(ctx)).includes('All documents'), '')

  // ── 옮길 곳 고르기 — 옮기는 폴더와 그 자손은 잠긴다 ──
  await clickExact(ctx, 'Select documents')
  await sleep(300)
  await tickRow(ctx, 'Books')
  await sleep(300)
  await clickExact(ctx, 'Move selected to a folder')
  await sleep(400)
  ctx.check('옮기는 폴더는 잠긴다', await lockedOption(ctx, 'Books'), '')
  await expandFirst(ctx)
  await sleep(300)
  ctx.check('자손도 잠긴다', await lockedOption(ctx, 'Short'), '')
  await ctx.pressEscape()
  await sleep(300)
  await clickExact(ctx, 'Cancel')
  await sleep(300)

  // ── 이름 바꾸기 ──
  await openFolderMenu(ctx, 'Books')
  await sleep(300)
  await ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const input = d.querySelector('input[aria-label="Folder name"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Novels');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...d.querySelectorAll('button')].find(x => x.innerText.trim() === 'Rename').click();
  })()`)
  await sleep(500)
  ctx.check('이름이 바뀐다', await folderRowExists(ctx, 'Novels'), '')

  // ── 폴더를 지운다 — 안의 것은 부모로 옮겨 간다 ──
  await openFolderMenu(ctx, 'Novels')
  await sleep(300)
  const deleted = await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('[role="dialog"] button')].find(x => x.innerText === 'Delete folder');
    if (!b) return false;
    b.click();
    return true;
  })()`)
  ctx.check('폴더를 지울 수 있다', deleted === true, String(deleted))
  await sleep(500)
  ctx.check('지운 폴더는 줄에서 사라진다', !(await folderRowExists(ctx, 'Novels')), '')
  ctx.check('지운 폴더의 문서는 뿌리로 돌아온다', (await docRowsCount(ctx)) === 1, await rows(ctx))
  ctx.check('하위 폴더는 뿌리로 올라온다', await folderRowExists(ctx, 'Short'), '')

  // ── 골라 담아 폴더째 버린다 — 안의 것은 사라지지 않는다 ──
  await clickExact(ctx, 'Select documents')
  await sleep(300)
  await tickRow(ctx, 'Short')
  await sleep(300)
  await clickExact(ctx, 'Move selected to trash')
  await sleep(500)
  ctx.check('버린 폴더는 줄에서 사라진다', !(await folderRowExists(ctx, 'Short')), '')
  ctx.check('문서는 그대로 있다', (await docRowsCount(ctx)) === 1, await rows(ctx))

  // ── 행마다 옮기기 단추는 없다 (골라 담기가 유일한 입구) ──
  const rowMove = await ctx.page.evaluate(
    `!!document.querySelector('button[aria-label="Move to folder"]')`,
  )
  ctx.check('행 옮기기 단추가 없다', rowMove === false, String(rowMove))
}

async function body(ctx) {
  return ctx.bodyText()
}

function sleep(ms = 400) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 단추를 이름 포함으로 눌른다 — clickText 는 정확히 일치만 된다 */
async function clickButtonIncludes(ctx, label) {
  const ok = await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.innerText.includes(${JSON.stringify(label)}));
    if (!b) return false;
    b.click();
    return true;
  })()`)
  if (!ok) throw new Error(`단추를 찾지 못함: ${label}`)
}

/** 정확히 일치하는 단추를 눌른다 */
async function clickExact(ctx, label) {
  const ok = await ctx.clickText(label)
  if (!ok) throw new Error(`단추를 찾지 못함: ${label}`)
}

async function clickBack(ctx) {
  const ok = await ctx.page.evaluate(`(() => {
    const b = document.querySelector('button[aria-label="Back"]');
    if (!b) return false;
    b.click();
    return true;
  })()`)
  if (!ok) throw new Error('뒤로 단추 없음')
}

async function folderRowExists(ctx, name) {
  return ctx.page.evaluate(`(() =>
    [...document.querySelectorAll('ul li')].some(li => li.innerText.includes(${JSON.stringify(name)})))()`)
}

async function docRowsCount(ctx) {
  return ctx.page.evaluate(`document.querySelectorAll('ul a[href^="/read/"]').length`)
}

async function rows(ctx) {
  return ctx.page.evaluate(`(() =>
    [...document.querySelectorAll('ul a[href^="/read/"]')].map(a => a.innerText).join(' '))()`)
}

/** 폴더 안으로 들어간다 — 폴더 줄의 단추를 눌른다 */
async function enterFolder(ctx, name) {
  const ok = await ctx.page.evaluate(`(() => {
    const li = [...document.querySelectorAll('ul li')].find(li => li.innerText.includes(${JSON.stringify(name)}));
    if (!li) return false;
    li.querySelector('button').click();
    return true;
  })()`)
  if (!ok) throw new Error(`폴더 줄을 찾지 못함: ${name}`)
}

/** 골라 담는 중 줄을 눌러 체크한다 */
async function tickRow(ctx, name) {
  const ok = await ctx.page.evaluate(`(() => {
    const li = [...document.querySelectorAll('ul li')].find(li => li.innerText.includes(${JSON.stringify(name)}));
    if (!li) return false;
    li.querySelector('button').click();
    return true;
  })()`)
  if (!ok) throw new Error(`고를 줄을 찾지 못함: ${name}`)
}

async function pickOption(ctx, label) {
  const ok = await ctx.page.evaluate(`(() => {
    const o = [...document.querySelectorAll('[role="option"]')].find(x => x.innerText.includes(${JSON.stringify(label)}));
    if (!o) return false;
    const b = o.tagName === 'BUTTON' ? o : o.querySelector('button');
    if (!b) return false;
    b.click();
    return true;
  })()`)
  if (!ok) throw new Error(`옮길 폴더 옵션을 찾지 못함: ${label}`)
}

/** 잠긴(고를 수 없는) 옵션인가 */
async function lockedOption(ctx, label) {
  return ctx.page.evaluate(`(() => {
    const o = [...document.querySelectorAll('[role="option"]')].find(x => x.innerText.includes(${JSON.stringify(label)}));
    return !!o && o.getAttribute('aria-disabled') === 'true';
  })()`)
}

/** 나무의 첫 번째 펼치기 단추를 눌른다 */
async function expandFirst(ctx) {
  const ok = await ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const b = d ? [...d.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === '▸') : null;
    if (!b) return false;
    b.click();
    return true;
  })()`)
  if (!ok) throw new Error('펼치기 단추 없음')
}

/** 폴더 줄의 ⋯ 메뉴를 연다 */
async function openFolderMenu(ctx, name) {
  const ok = await ctx.page.evaluate(`(() => {
    const li = [...document.querySelectorAll('ul li')].find(li => li.innerText.includes(${JSON.stringify(name)}));
    const b = li ? li.querySelector('button[aria-label="Folder actions"]') : null;
    if (!b) return false;
    b.click();
    return true;
  })()`)
  if (!ok) throw new Error(`폴더 메뉴 없음: ${name}`)
}
