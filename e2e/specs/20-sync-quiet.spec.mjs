/**
 * 저장 상태 표시가 조용한지.
 *
 * 자동 동기화가 돌 때마다 'up to date' 와 'syncing' 이 번갈아 바뀌면 사람이 판단할
 * 수 없다 — 읽는 내내 깜빡이니 결국 무시하게 된다.
 *
 * 여기서는 로그인하지 않은 상태를 본다. 서버를 쓰지 않으면 저장은 곧 로컬이다 —
 * 화면이 '아무것도 말하지 않는' 상태로 머무는지 확인한다.
 */

export async function run(ctx) {
  await ctx.enrollLanguage('Korean')

  // 아무것도 저장하지 않은 상태에서 상단이 조용해야 한다
  await sleep(2500)
  const quiet = await ctx.page.evaluate(`(() => {
    const text = document.body.innerText;
    return {
      notSynced: /Not synced yet|저장 대기 중/.test(text),
      saving: /Saving…|저장 중/.test(text),
      failed: /Save failed|저장 실패/.test(text),
    };
  })()`)
  ctx.check('조용한 상태에서 아무것도 말하지 않는다',
    !quiet.notSynced && !quiet.saving && !quiet.failed, JSON.stringify(quiet))

  // 로그인하지 않았으니 '지금 동기화' 도 결과를 말할 일이 없다 — 눌러도 조용해야 한다
  await ctx.clickSelector('a[href="/settings"]')
  await sleep(600)
  const before = await ctx.page.evaluate(`document.body.innerText`)
  await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /Sync now|지금 동기화/.test(x.innerText));
    if (!b) return false;
    b.click();
    return true;
  })()`)
  await sleep(1500)
  const after = await ctx.page.evaluate(`(() => {
    const text = document.body.innerText;
    return {
      changed: text !== ${JSON.stringify(before)},
      notSynced: /Not synced yet|저장 대기 중/.test(text),
      failed: /Save failed|저장 실패/.test(text),
    };
  })()`)
  ctx.check('로그인하지 않았으면 결과를 말하지 않는다',
    after.changed === false && after.notSynced === false && after.failed === false,
    JSON.stringify(after))

  // 설정 화면에 상태 줄은 있어도, 조용한 상태에서 '동기화 중' 이 새로 생기면 안 된다
  const status = await ctx.page.evaluate(`(() => {
    const row = [...document.querySelectorAll('dt')].find(x => /Status|동기화/.test(x.innerText));
    if (!row) return null;
    return row.nextElementSibling?.innerText?.trim() ?? null;
  })()`)
  ctx.check('설정 화면의 상태가 안정적이다',
    status === null || !/syncing|동기화 중/i.test(status), String(status))
}

function sleep(ms = 400) {
  return new Promise((r) => setTimeout(r, ms))
}