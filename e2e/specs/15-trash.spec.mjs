/** 제목 바꾸기 → 휴지통 → 되살리기 → 완전 삭제 */

export async function run(ctx) {
  await ctx.enrollLanguage('Korean')
  await ctx.typeIntoTextarea('The quick brown fox jumps over the lazy dog every single morning.')
  await ctx.clickText('Create document')
  await sleep()

  // 만든 문서는 목록에서 연다 — 본문에 바로 열리지는 않는다
  await ctx.clickSelector('a[href="/"]')
  await sleep(600)
  await ctx.waitFor(
    `!![...document.querySelectorAll('a')].find(x=>x.getAttribute('href')?.startsWith('/read/'))`,
    '문서 목록',
  )
  await ctx.page.evaluate(`(() => {
    const link = [...document.querySelectorAll('a')].find(x => x.getAttribute('href')?.startsWith('/read/'));
    link.click();
    return true;
  })()`)
  await sleep(600)

  // ── 제목 바꾸기 ──
  const opened = await ctx.bodyText()
  ctx.check('문서가 열렸다', /morning/.test(opened), opened.split('\n').slice(0, 2).join(' | '))

  await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => /제목을 바꿉니다|rename/i.test(x.getAttribute('title') ?? ''));
    if (!b) return false;
    b.click();
    return true;
  })()`)
  await sleep(300)

  const editing = await ctx.page.evaluate(`(() => {
    const i = document.querySelector('input[aria-label]');
    if (!i) return null;
    i.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(i, '아침마다 읽는 짧은 글');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  ctx.check('제목을 고칠 수 있게 된다', editing === true, String(editing))
  await sleep(300)
  await ctx.page.evaluate(`(() => {
    const i = document.querySelector('input[aria-label]');
    if (!i) return false;
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`)
  await sleep(400)
  ctx.check('바꾼 제목이 보인다', (await ctx.bodyText()).includes('아침마다 읽는 짧은 글'),
    (await ctx.bodyText()).split('\n').slice(0, 2).join(' | '))

  // 빈 제목은 받지 않는다 — 목록에서 구분할 수단이 없어진다
  await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => /제목을 바꿉니다|rename/i.test(x.getAttribute('title') ?? ''));
    b.click();
    return true;
  })()`)
  await sleep(300)
  await ctx.page.evaluate(`(() => {
    const i = document.querySelector('input[aria-label]');
    i.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(i, '   ');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await sleep(200)
  await ctx.page.evaluate(`(() => {
    const i = document.querySelector('input[aria-label]');
    if (!i) return false;
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`)
  await sleep(400)
  ctx.check('빈 제목은 받지 않는다', (await ctx.bodyText()).includes('아침마다 읽는 짧은 글'),
    (await ctx.bodyText()).split('\n').slice(0, 2).join(' | '))

  // ── 휴지통 — 누르면 먼저 한 번 묻는다 ──
  await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => /휴지통으로|Move to trash/i.test(x.innerText));
    if (!b) return false;
    b.click();
    return true;
  })()`)
  await sleep(600)
  const asked = await ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    return d ? d.innerText : null;
  })()`)
  ctx.check('버리기 전에 한 번 묻는다', typeof asked === 'string', String(asked))
  ctx.check('묻는 동안에는 아직 안 버렸다', (await ctx.bodyText()).includes('아침마다 읽는 짧은 글'),
    (await ctx.bodyText()).split('\n').slice(0, 2).join(' | '))

  // 그만두기 — 상자는 닫히고 문서는 그대로다
  await ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const b = d ? [...d.querySelectorAll('button')].find(x => /취소|^Cancel$/.test(x.innerText)) : null;
    if (!b) return false;
    b.click();
    return true;
  })()`)
  await sleep(400)
  const closedGone = await ctx.page.evaluate(`!!document.querySelector('[role="dialog"]')`)
  ctx.check('그만두면 상자가 닫힌다', closedGone === false, String(closedGone))
  ctx.check('그만두면 문서가 그대로다', (await ctx.bodyText()).includes('아침마다 읽는 짧은 글'))

  // 이번에는 확인 — 버려진다
  await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => /휴지통으로|Move to trash/i.test(x.innerText));
    if (!b) return false;
    b.click();
    return true;
  })()`)
  await sleep(600)
  await ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const b = d ? [...d.querySelectorAll('button')].find(x => /휴지통으로|Move to trash/i.test(x.innerText)) : null;
    if (!b) return false;
    b.click();
    return true;
  })()`)
  await sleep(600)
  const listText = await ctx.bodyText()
  // 마지막 문서를 버렸으니 이제 빈 목록이 보인다 — 작성 화면으로 넘어가지 않는다
  ctx.check('목록으로 돌아온다', !/Paste a text/.test(listText), listText.split('\n')[0])
  ctx.check('목록에서 사라진다', !listText.includes('아침마다 읽는 짧은 글'))
  ctx.check('휴지통에 들어갔다고 말한다', /휴지통|Trash/.test(listText), listText.split('\n').slice(0, 6).join(' | '))

  // ── 되살리기 ──
  await ctx.page.evaluate(`(() => {
    const a = [...document.querySelectorAll('a')].find(x => /휴지통|Trash/.test(x.innerText));
    if (!a) return false;
    a.click();
    return true;
  })()`)
  await sleep(500)
  ctx.check('휴지통 화면이 열린다', (await ctx.bodyText()).includes('아침마다 읽는 짧은 글'),
    (await ctx.bodyText()).split('\n').slice(0, 3).join(' | '))
  ctx.check('휴지통에서 문서의 언어가 보인다', /Korean/.test(await ctx.bodyText()),
    (await ctx.bodyText()).split('\n').slice(0, 4).join(' | '))

  await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /되살리기|Restore/.test(x.innerText));
    if (!b) return false;
    b.click();
    return true;
  })()`)
  await sleep(500)
  ctx.check('되살린 문서는 휴지통에서 빠진다', !(await ctx.bodyText()).includes('아침마다 읽는 짧은 글'),
    (await ctx.bodyText()).split('\n').slice(0, 3).join(' | '))

  await ctx.page.evaluate(`(() => {
    const a = [...document.querySelectorAll('a')].find(x => /닫기|Close/.test(x.innerText));
    if (!a) return false;
    a.click();
    return true;
  })()`)
  await sleep(500)
  ctx.check('목록에 다시 보인다', (await ctx.bodyText()).includes('아침마다 읽는 짧은 글'),
    (await ctx.bodyText()).split('\n').slice(0, 4).join(' | '))

  // ── 완전 삭제 ──
  // 목록에서 문서를 열어 읽기 화면으로 간다 (읽기 화면의 '휴지통으로' 단추가起点이다)
  await ctx.page.evaluate(`(() => {
    const link = [...document.querySelectorAll('a')].find(x => x.getAttribute('href')?.startsWith('/read/'));
    if (!link) return false;
    link.click();
    return true;
  })()`)
  await sleep(600)
  await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /휴지통으로|Move to trash/i.test(x.innerText));
    if (!b) return false;
    b.click();
    return true;
  })()`)
  await sleep(600)
  await ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const b = d ? [...d.querySelectorAll('button')].find(x => /휴지통으로|Move to trash/i.test(x.innerText)) : null;
    if (!b) return false;
    b.click();
    return true;
  })()`)
  await sleep(600)
  await ctx.page.evaluate(`(() => {
    const a = [...document.querySelectorAll('a')].find(x => /휴지통|Trash/.test(x.innerText));
    if (!a) return false;
    a.click();
    return true;
  })()`)
  await sleep(500)
  // ── 완전 삭제 — 여기도 먼저 한 번 묻는다 ──
  await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /완전 삭제|Delete for good/.test(x.innerText));
    if (!b) return false;
    b.click();
    return true;
  })()`)
  await sleep(600)
  const askedPurge = await ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    return d ? d.innerText : null;
  })()`)
  ctx.check('완전 삭제 전에 한 번 묻는다', typeof askedPurge === 'string', String(askedPurge))
  ctx.check('묻는 동안에는 아직 있다', /Restore|되살리기/.test(await ctx.bodyText()),
    (await ctx.bodyText()).split('\n').slice(0, 3).join(' | '))

  await ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const b = d ? [...d.querySelectorAll('button')].find(x => /취소|^Cancel$/.test(x.innerText)) : null;
    if (!b) return false;
    b.click();
    return true;
  })()`)
  await sleep(400)
  ctx.check('그만두면 휴지통에 그대로 있다', /Restore|되살리기/.test(await ctx.bodyText()))

  await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /완전 삭제|Delete for good/.test(x.innerText));
    if (!b) return false;
    b.click();
    return true;
  })()`)
  await sleep(600)
  await ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const b = d ? [...d.querySelectorAll('button')].find(x => /완전 삭제|Delete for good/.test(x.innerText)) : null;
    if (!b) return false;
    b.click();
    return true;
  })()`)
  await sleep(600)
  ctx.check('완전 삭제하면 휴지통도 비어 있다', !/Restore|되살리기/.test(await ctx.bodyText()),
    (await ctx.bodyText()).split('\n').slice(0, 3).join(' | '))
}
function sleep(ms = 400) {
  return new Promise((r) => setTimeout(r, ms))
}
