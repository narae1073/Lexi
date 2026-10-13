/** ★ 탭의 별 색 필터 — 여러 색을 겹쳐 켜면 켠 색의 즐겨찾기만 남는다 */

const DE_TEXT = 'Das Haus ist groß und der Hund ist klein.'

export async function run(ctx) {
  await ctx.enrollLanguage('German')
  await ctx.createDocument(DE_TEXT, 'German')

  // ── 문서에서 별을 붙이고 색을 고른다 ──
  await starWithColor(ctx, 'Haus', '#ef4444') // 빨강
  await starWithColor(ctx, 'groß', '#3b82f6') // 파랑
  await sleep()

  // ── 단어장 ★ 탭 ──
  await ctx.clickSelector('a[href="/wordbook"]')
  await sleep(800)
  await gotoFavoriteTab(ctx)
  await sleep(400)

  // 색창이 있다 — 팝오버의 색창과 같은 9색이다
  const swatches = await ctx.page.evaluate(`(() =>
    [...document.querySelectorAll('[data-star-filter]')].map(b => b.getAttribute('data-star-filter')))()`)
  ctx.check('색 필터 9색이 있다', swatches.length === 9, swatches.join(' '))

  // 아무 색도 안 켠 상태 — ★ 탭 전체가 보인다
  const all = await lemmas(ctx)
  ctx.check('안 켜면 전체가 보인다', has(all, 'haus') && has(all, 'groß'), all.join(' '))

  // 빨강 하나 — 빨간 별만 남는다
  await toggleFilter(ctx, '#ef4444')
  await sleep(400)
  let rows = await lemmas(ctx)
  ctx.check('빨강만 켜면 빨간 별만 남는다', has(rows, 'haus') && !has(rows, 'groß'), rows.join(' '))

  // 파랑을 겹쳐 켠다 — 두 개가 다 보인다
  await toggleFilter(ctx, '#3b82f6')
  await sleep(400)
  rows = await lemmas(ctx)
  ctx.check('두 색을 겹치면 다 보인다', has(rows, 'haus') && has(rows, 'groß'), rows.join(' '))

  // 빨강을 다시 눌러 끈다 — 파란 별만 남는다
  await toggleFilter(ctx, '#ef4444')
  await sleep(400)
  rows = await lemmas(ctx)
  ctx.check('빨강을 끄면 파란 별만 남는다', !has(rows, 'haus') && has(rows, 'groß'), rows.join(' '))

  // 파랑도 끈다 — 좁힘이 풀린다
  await toggleFilter(ctx, '#3b82f6')
  await sleep(400)
  rows = await lemmas(ctx)
  ctx.check('다 끄면 전체로 돌아온다', has(rows, 'haus') && has(rows, 'groß'), rows.join(' '))

  // ── 다른 탭에는 색창이 없고 목록도 좁혀지지 않는다 ──
  await ctx.page.evaluate(`(() => {
    const tab = [...document.querySelectorAll('button')].find(x => x.innerText.trim().startsWith('Not marked'));
    if (tab) tab.click();
    return true;
  })()`)
  await sleep(400)
  const elsewhere = await ctx.page.evaluate(`(() =>
    document.querySelectorAll('[data-star-filter]').length)()`)
  ctx.check('다른 탭에는 색창이 없다', elsewhere === 0, String(elsewhere))
  const unmarked = await lemmas(ctx)
  ctx.check('다른 탭의 목록은 좁혀지지 않는다', has(unmarked, 'hund') && has(unmarked, 'klein'), unmarked.join(' '))

  // ── ★ 탭으로 돌아와도 아직 아무 색도 켜져 있지 않다 ──
  await gotoFavoriteTab(ctx)
  await sleep(400)
  rows = await lemmas(ctx)
  ctx.check('돌아오면 전체가 다시 보인다', has(rows, 'haus') && has(rows, 'groß'), rows.join(' '))

  // ── 아무 것도 맞는 색이 없으면 '없다' 고 말한다 ──
  await toggleFilter(ctx, '#a855f7') // 보라 — 별 색이 보라인 단어는 없다
  await sleep(400)
  const emptyText = await ctx.page.evaluate(`(() => {
    const rows = document.querySelectorAll('[data-wordbook-lemma]').length;
    const p = [...document.querySelectorAll('p')].find(x => /No favorites with these colors/.test(x.innerText));
    return { rows, said: Boolean(p) };
  })()`)
  ctx.check('맞는 색이 없으면 없다고 말한다', emptyText.rows === 0 && emptyText.said, JSON.stringify(emptyText))
  await toggleFilter(ctx, '#a855f7')
  await sleep(300)
}

/** 대소문자를 무시하고 lemma 가 목록에 있는지 — Hund/hund 는 같은 단어다 */
function has(rows, lemma) {
  return rows.some((r) => r.toLowerCase() === lemma.toLowerCase())
}

/**
 * 단어 팝오버에서 별을 붙이고 색을 고른다.
 *
 * ☆를 누르면 별이 붙고(색은 무작위), 색창 버튼 옆에 펼쳐진 색창에서
 * 고른 색으로 바뀐다.
 */
async function starWithColor(ctx, surface, hex) {
  await ctx.clickWord(surface)
  await sleep(400)
  const starred = await ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const b = d && [...d.querySelectorAll('button')].find(x => x.innerText === '☆' || x.innerText === '★');
    if (!b) return false;
    if (b.innerText === '☆') b.click();
    return true;
  })()`)
  if (!starred) throw new Error(`팝오버를 못 찾음: ${surface}`)
  await sleep(400)

  const opened = await ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const b = d && [...d.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === 'Pick a star color');
    if (!b) return false;
    b.click();
    return true;
  })()`)
  if (!opened) throw new Error(`색창 버튼 없음: ${surface}`)
  await sleep(300)

  const picked = await ctx.page.evaluate(`(() => {
    const b = document.querySelector('[data-star-color="${hex}"]');
    if (!b) return false;
    b.click();
    return true;
  })()`)
  if (!picked) throw new Error(`색을 못 찾음: ${hex}`)
  await sleep(300)
  await ctx.pressEscape()
  await sleep()
}

async function toggleFilter(ctx, hex) {
  return ctx.page.evaluate(`(() => {
    const b = document.querySelector('[data-star-filter="${hex}"]');
    if (!b) return false;
    b.click();
    return true;
  })()`)
}

/** 단어장 목록의 lemma 들 — 행의 첫 단어 버튼이다 */
function lemmas(ctx) {
  return ctx.page.evaluate(`(() =>
    [...document.querySelectorAll('[data-wordbook-lemma]')].map(b => b.getAttribute('data-wordbook-lemma')))()`)
}

/** ★ 탭으로 옮긴다 — 마지막 탭 기억이 다른 곳에 있을 수 있으므로 */
async function gotoFavoriteTab(ctx) {
  await ctx.page.evaluate(`(() => {
    const tab = [...document.querySelectorAll('button')].find(x => x.innerText.trim().startsWith('★ Favorites'));
    if (tab) tab.click();
    return true;
  })()`)
  await sleep(400)
}

function sleep() {
  return new Promise((r) => setTimeout(r, 400))
}
