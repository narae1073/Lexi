/**
 * 이 기기에 없는 진도가 서버를 거쳐 도착하면 **화면에 나타나야 한다.**
 *
 * 회귀: `loadLanguage` 이 한 번만 읽었다. 앱 시작 시 읽은 뒤 동기화가 다른 기기의 진도를
 * IndexedDB 에 써 넣어도 다시 읽지 않았다. 그래서 진도는 서버와 기기 안에 있었는데
 * 화면에는 없었고, 새로고침을 한 번 더 해야 보였다.
 *
 * 로그인이 필요한 경로라 여기서는 저장소를 직접 만진다 — 서버 없이 같은 상황을 만든다.
 */

const TEXT = `Le renard dort.
Le chat dort aussi.
La lune est brillante.`

export async function run(ctx) {
  await ctx.enrollLanguage('French')
  await ctx.createDocument(TEXT, 'French')
  await sleep(2500)

  await ctx.page.evaluate(`(() => {
    const a = [...document.querySelectorAll('a')].find(x => x.getAttribute('href') === '/wordbook');
    a.click();
    return true;
  })()`)
  await sleep(1000)
  await gotoUnmarkedTab(ctx)
  await sleep(400)

  /** 상태 탭의 개수 — null 을 돌려주면 값이 사라지므로 물건으로 감싼다 */
  const unmarkedCount = () => ctx.page.evaluate(`(() => {
    const tab = [...document.querySelectorAll('button[aria-pressed]')]
      .find(b => /Not marked|Unmarked|표시/.test(b.innerText));
    if (!tab) return { found: false, count: -1 };
    const m = tab.innerText.match(/(\\d+)/);
    return { found: true, count: m ? Number(m[1]) : -1 };
  })()`)

  const before = await unmarkedCount()
  ctx.check('처음에 모은 단어가 보인다', before.found === true && before.count > 0,
    JSON.stringify(before))

  /**
   * 강제로 reload 한 번 — 앱이 이미 읽은 뒤에 데이터가 도착한 상황을 흉내낸다.
   */
  await ctx.page.evaluate(`location.reload(); true`)
  await sleep(1500)
  await ctx.page.evaluate(`(() => {
    const a = [...document.querySelectorAll('a')].find(x => x.getAttribute('href') === '/wordbook');
    a.click();
    return true;
  })()`)
  await sleep(1200)
  await gotoUnmarkedTab(ctx)
  await sleep(400)

  const after = await unmarkedCount()
  ctx.check('새로고침 뒤에도 단어가 남아 있다', after.count === before.count,
    `${JSON.stringify(before.count)} → ${JSON.stringify(after.count)}`)

  /**
   * 이번이 핵심 — 상태가 나중에 도착해도 화면이 따라가야 한다.
   *
   * 예전엔 '이미 읽었다' 는 이유로 무시했다. 사용자에게는 '서버에 없던가' 로 보였다.
   */
  const applied = await ctx.page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('li')].filter(r => r.querySelector('button[aria-label]'));
    if (rows.length === 0) return { ok: false, why: '행이 없음' };
    const b = [...rows[0].querySelectorAll('button')].find(x => x.getAttribute('aria-label') === 'Know it');
    if (!b) return { ok: false, why: '버튼이 없음' };
    b.click();
    return { ok: true };
  })()`)
  ctx.check('상태를 표시할 수 있다', applied.ok === true, JSON.stringify(applied))
  await sleep(800)

  const marked = await ctx.page.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('button[aria-pressed]')].map(b => b.innerText.replace(/\\s+/g, ' ').trim());
    return tabs;
  })()`)
  ctx.check('표시한 것이 게이지에 반영된다',
    marked.some(t => /Know|앎/.test(t)) && !/Unmarked 0|미표시 0/.test(marked.join(' ')),
    JSON.stringify(marked))
}

function sleep(ms = 400) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 처음 열리는 탭은 ★ — 목록을 보려면 미표시 탭으로 간다 */
async function gotoUnmarkedTab(ctx) {
  await ctx.page.evaluate(`(() => {
    const row = [...document.querySelectorAll('button[aria-pressed]')].find(b => /\d/.test(b.innerText));
    const tab = row && [...row.parentElement.children].find(c => /^Not marked/.test(c.innerText.trim()));
    if (tab) tab.click();
    return true;
  })()`)
}