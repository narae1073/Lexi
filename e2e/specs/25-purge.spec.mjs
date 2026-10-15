/**
 * 완전 삭제는 되돌아오지 않는다.
 *
 * 회귀 두 가지:
 * 1. 저장을 다 끝낸 뒤 화면에서 뺐는데, 중간 한 단계가 실패하면 그 뒤를 아예 실행하지
 *    않아 눌렀는데도 남아 있었다 — 새로고침해야 사라졌다
 * 2. 삭제 요청과 동기화가 겹치면 서버에서 지운 문서가 그대로 내려와 되살아났다.
 *    병합이 되살리고, 다음 동기화가 그것을 서버에 다시 올렸다
 */

export async function run(ctx) {
  await ctx.enrollLanguage('Korean')
  await ctx.createDocument('어느 문서든 되살아나면 안 됩니다.', 'Korean')
  await sleep(1500)

  await ctx.clickSelector('a[href="/"]')
  await sleep(600)
  await ctx.page.evaluate(`(() => {
    const li = [...document.querySelectorAll('li')].find(x => x.querySelector('a[href^="/read/"]'));
    li.querySelector('a[href^="/read/"]').click();
    return true;
  })()`)
  await sleep(700)
  await ctx.waitFor(`!!document.querySelector('[data-start]')`, '본문')

  // 휴지통으로 보낸다 — 누르면 한 번 묻는다 (확인해야 실제로 버려진다)
  await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /휴지통으로|Move to trash/.test(x.innerText));
    b.click();
    return true;
  })()`)
  await sleep(500)
  await ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const b = d && [...d.querySelectorAll('button')].find(x => /휴지통으로|Move to trash/.test(x.innerText));
    if (!b) return false;
    b.click();
    return true;
  })()`)
  await sleep(700)
  await ctx.page.evaluate(`(() => {
    const a = [...document.querySelectorAll('a')].find(x => /휴지통|Trash/.test(x.innerText));
    a.click();
    return true;
  })()`)
  await sleep(600)
  ctx.check('휴지통에 들어있다', /완전 삭제|Delete for good/.test(await ctx.bodyText()),
    (await ctx.bodyText()).split('\n').slice(0, 3).join(' | '))

  // 완전 삭제 — 여기도 한 번 묻는다
  const before = await ctx.page.evaluate(`window.__docId = location.pathname`)
  await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /완전 삭제|Delete for good/.test(x.innerText));
    if (!b) return false;
    b.click();
    return true;
  })()`)
  await sleep(500)
  await ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const b = d && [...d.querySelectorAll('button')].find(x => /완전 삭제|Delete for good/.test(x.innerText));
    if (!b) return false;
    b.click();
    return true;
  })()`)

  /** 눌렀는데 남아 있으면 안 된다 — 저장이 늦어도 화면은 먼저야 한다 */
  await sleep(150)
  const immediately = await ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const body = document.body.innerText;
    return { hasDialog: !!d, stillThere: /완전 삭제|Delete for good/.test(body) };
  })()`)
  ctx.check('누르면 곧바로 사라진다', immediately.stillThere === false, JSON.stringify(immediately))

  // 동기화가 도는 시간 — resurrect 의 시간
  for (const wait of [1500, 3000, 4000]) {
    await sleep(wait)
    const stillGone = await ctx.page.evaluate(`(() => {
      const body = document.body.innerText;
      return !/완전 삭제|Delete for good/.test(body);
    })()`)
    ctx.check(`${wait}ms 뒤에도 돌아오지 않는다`, stillGone === true, String(stillGone))
  }

  await ctx.page.evaluate(`location.reload(); true`)
  await sleep(1500)
  const afterReload = await ctx.bodyText()
  ctx.check('새로고침해도 없다', !/완전 삭제|Delete for good/.test(afterReload),
    afterReload.split('\n').slice(0, 3).join(' | '))

  // 목록에도 없고 휴지통에도 없어야 한다
  await ctx.clickSelector('a[href="/"]')
  await sleep(700)
  const listText = await ctx.bodyText()
  ctx.check('목록에도 없다', !listText.includes('어느 문서든 되살아나면 안 됩니다.'),
    listText.split('\n').slice(0, 5).join(' | '))

  await ctx.clickSelector('a[href="/trash"]')
  await sleep(600)
  const trashText = await ctx.bodyText()
  ctx.check('휴지통에도 없다', !trashText.includes('어느 문서든 되살아나면 안 됩니다.'),
    trashText.split('\n').slice(0, 4).join(' | '))

  /**
   * 단어장에서도 지워져야 한다.
   *
   * `forgetDocument` 가 중간에 예외를 던지면 기억 속 목록이 갱신되지 않아, 완전 삭제한
   * 문서의 단어가 단어장에 그대로 남았다 — 새로고침해야 사라졌다.
   */
  await ctx.clickSelector('a[href="/wordbook"]')
  await sleep(1000)
  // 처음 열리는 탭은 ★ — 지워진 단어가 없는지 미표시 목록에서 본다
  await ctx.page.evaluate(`(() => {
    const row = [...document.querySelectorAll('button[aria-pressed]')].find(b => /\\d/.test(b.innerText));
    const tab = row && [...row.parentElement.children].find(c => /^Not marked/.test(c.innerText.trim()));
    if (tab) tab.click();
    return true;
  })()`)
  await sleep(500)
  const wordbook = await ctx.bodyText()
  ctx.check('단어장에서도 지워진 단어는 없다',
    !/되살아나면|should not come back/.test(wordbook),
    JSON.stringify(wordbook.slice(0, 400)))

  void before
}

function sleep(ms = 400) {
  return new Promise((r) => setTimeout(r, ms))
}