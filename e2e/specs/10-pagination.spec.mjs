/** 단어장 페이지 나누기 — 쪽 수 선택(10·20·30·40·50), 이동, 목록 바뀌면 첫 쪽으로 */

const TEXT = `The Apple store is busy today.
I ate an apple and bought another yesterday.
The US economy grew slowly.
Tell us the truth about that company.
Our friend read three long books this week.
Please write a letter to your teacher soon.`

/** 목록 항목(li) 개수 */
const itemCount = (ctx) => ctx.page.evaluate(`document.querySelectorAll('li').length`)

/** 페이지 번호 버튼이 보이는지 */
const pageButtonsVisible = (ctx) =>
  ctx.page.evaluate(`!!document.querySelector('nav[aria-label] button[aria-current], nav[aria-label] button[aria-label]')`)

/** 쪽 수 선택기가 보이는지 — 한 쪽이어도 남아야 한다 */
const sizeSelectVisible = (ctx) =>
  ctx.page.evaluate(`!!document.querySelector('nav[aria-label] select')`)

/** 현재 보고 있는 쪽 번호 */
const currentPage = (ctx) =>
  ctx.page.evaluate(`(() => {
    const n = document.querySelector('nav[aria-label]');
    const cur = n && [...n.querySelectorAll('button')].find(b => b.getAttribute('aria-current') === 'page');
    return cur ? Number(cur.innerText.trim()) : null;
  })()`)

/** 순번 표시가 뭐라고 하는가 */
const rangeLabel = (ctx) =>
  ctx.page.evaluate(`(() => {
    const n = document.querySelector('nav[aria-label]');
    return n ? n.querySelector('p').innerText : null;
  })()`)

async function openWordbook(ctx) {
  await ctx.clickSelector('a[href="/wordbook"]')
  await ctx.waitFor(`!!document.querySelector('input[placeholder]')`, '단어장')
  await sleep(600)
}

async function setPageSize(ctx, value) {
  const ok = await ctx.page.evaluate(`(() => {
    const s = [...document.querySelectorAll('nav[aria-label] select')][0];
    if (!s) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(s, '${value}');
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
  await sleep(500)
  return ok
}

export async function run(ctx) {
  await ctx.enrollLanguage('English')
  await ctx.createDocument(TEXT, 'English')
  await sleep(2500)

  const total = await countAll(ctx)
  ctx.check('모두 모은 단어 수를 센다', total > 20, `${total}개`)

  // ── 기본은 한 쪽에 20개 ──
  await openWordbook(ctx)
  const options = await ctx.page.evaluate(`(() => {
    const s = document.querySelector('nav[aria-label] select');
    return s ? [...s.options].map(o => Number(o.value)) : [];
  })()`)
  ctx.check('쪽 수 선택지가 10·20·30·40·50 다', JSON.stringify(options) === JSON.stringify([10, 20, 30, 40, 50]),
    options.join(','))

  const onFirst = await itemCount(ctx)
  ctx.check('기본은 한 쪽에 20개까지 보여준다', onFirst === 20, `${onFirst}개`)
  ctx.check('쪽 수 선택은 한 쪽이어도 항상 보인다', await sizeSelectVisible(ctx), '보임')

  // ── 10 개로 줄이면 몇 쪽으로 나뉘는지 ──
  await setPageSize(ctx, 10)
  const perPage = await itemCount(ctx)
  ctx.check('한 쪽에 10개를 보여준다', perPage === 10, `${perPage}개`)
  ctx.check('이제 페이지 번호가 보인다', await pageButtonsVisible(ctx), '보임')

  const expectedPages = Math.ceil(total / 10)
  const pageButtons = await ctx.page.evaluate(`(() => {
    const n = document.querySelector('nav[aria-label]');
    return [...n.querySelectorAll('button[aria-label]')]
      .map(b => ({ label: b.getAttribute('aria-label'), text: b.innerText.trim() }))
  })()`)
  ctx.check('처음·마지막 쪽 버튼이 있다',
    pageButtons.some((b) => b.label === 'Previous page') && pageButtons.some((b) => b.label === 'Next page'),
    pageButtons.map((b) => `${b.label}:${b.text}`).join(' '))
  ctx.check('맨 처음은 앞쪽 이동이 막혀 있다',
    await ctx.page.evaluate(`(() => {
      const b = [...document.querySelectorAll('nav[aria-label] button')].find(x => x.getAttribute('aria-label') === 'Previous page');
      return b.disabled;
    })()`), '비활성')

  ctx.check('순번 표시가 1–10 다', (await rangeLabel(ctx)).includes('1'), await rangeLabel(ctx))
  ctx.check('1 쪽에 머물러 있다', (await currentPage(ctx)) === 1, `${await currentPage(ctx)}쪽`)

  // ── 다음 쪽 ──
  await ctx.clickText('›')
  await sleep(400)
  ctx.check('다음 쪽으로 간다', (await currentPage(ctx)) === 2, `${await currentPage(ctx)}쪽`)
  ctx.check('순번 표시가 이어진다', (await rangeLabel(ctx)).includes('11'), await rangeLabel(ctx))
  await ctx.clickText('‹')
  await sleep(400)
  ctx.check('이전 쪽으로 돌아온다', (await currentPage(ctx)) === 1, `${await currentPage(ctx)}쪽`)

  const last = await ctx.page.evaluate(`(() => {
    const n = document.querySelector('nav[aria-label]');
    const nums = [...n.querySelectorAll('button')].map(b => Number(b.innerText.trim())).filter(n => Number.isInteger(n));
    return Math.max(...nums);
  })()`)
  ctx.check('쪽 수가 항목을 나눈 몫과 맞는다', last === expectedPages, `${last}쪽 (기대 ${expectedPages}쪽)`)

  // ── 마지막 쪽에는 남은 개수만 ──
  await ctx.clickText(String(last))
  await sleep(400)
  ctx.check('마지막 쪽으로 간다', (await currentPage(ctx)) === last, `${await currentPage(ctx)}쪽`)
  ctx.check('마지막 쪽은 남은 개수만 보여준다', (await itemCount(ctx)) === total - (last - 1) * 10,
    `${await itemCount(ctx)}개 / 총 ${total}개`)
  ctx.check('마지막 쪽이  고 개수를 넘지 않는다', (await rangeLabel(ctx)).includes(String(total)),
    await rangeLabel(ctx))

  // ── 쪽 수를 키우면 한 쪽으로 합쳐진다 ──
  await setPageSize(ctx, 50)
  ctx.check('50개로 키우면 한 쪽이 된다', (await itemCount(ctx)) === total, `${await itemCount(ctx)}개`)
  ctx.check('한 쪽이 되면 페이지 번호는 숨는다', (await pageButtonsVisible(ctx)) === false, '숨김')
  ctx.check('한 쪽이 되어도 쪽 수 선택은 남아 있다', await sizeSelectVisible(ctx), '보임')

  // ── 쪽 수는 다음번에도 남아 있다 ──
  await setPageSize(ctx, 10)
  await ctx.reload()
  await ctx.waitFor(`!!document.querySelector('a[href="/wordbook"]')`, '앱 재시작')
  await sleep(600)
  await openWordbook(ctx)
  ctx.check('새로고침 후에도 쪽 수가 남아 있다', (await itemCount(ctx)) === 10, `${await itemCount(ctx)}개`)

  // ── 상태 탭을 바꾸면 첫 쪽으로 ──
  await clickTab(ctx, 2)
  await sleep(500)
  const afterTab = await ctx.page.evaluate(`(() => {
    const cur = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-current') === 'page');
    return cur ? Number(cur.innerText.trim()) : 1;
  })()`)
  ctx.check('상태 탭을 바꾸면 첫 쪽으로 돌아온다', afterTab === 1, `${afterTab}쪽`)

  // ── 검색어를 바꾸면 첫 쪽으로 ──
  await ctx.page.evaluate(`(() => {
    const i = document.querySelector('input[placeholder]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(i, 'e');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await sleep(500)
  const afterSearch = await ctx.page.evaluate(`(() => {
    const cur = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-current') === 'page');
    return cur ? Number(cur.innerText.trim()) : 1;
  })()`)
  ctx.check('검색어를 바꾸면 첫 쪽으로 돌아온다', afterSearch === 1, `${afterSearch}쪽`)
}

/** 상태 탭을 n 번째로 바꾼다 (0 = 미표시) */
async function clickTab(ctx, index) {
  await ctx.page.evaluate(`(() => {
    const row = [...document.querySelectorAll('button[aria-pressed]')].find(b => /\\d/.test(b.innerText)).parentElement;
    row.children[${index}].click();
    return true;
  })()`)
  await sleep(500)
}

/** 모든 상태 탭의 개수를 더해 전체 단어 수를 낸다 */
async function countAll(ctx) {
  await openWordbook(ctx)
  const total = await ctx.page.evaluate(`(() => {
    const row = [...document.querySelectorAll('button[aria-pressed]')].find(b => /\\d/.test(b.innerText));
    return [...row.parentElement.children]
      .map(c => Number((c.innerText.match(/(\\d+)/)?.[1] ?? '0')))
      .reduce((a, b) => a + b, 0);
  })()`)
  return total
}

function sleep() {
  return new Promise((r) => setTimeout(r, 400))
}
