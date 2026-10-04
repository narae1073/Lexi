/** 화면 전체 글자 크기 — 본문뿐 아니라 여백까지 같은 비율로 바뀌는지 */

const TEXT = `Ubiquitous smartphones changed communication.
The Apple store is busy.`

const SCALE_MIN = 85
const SCALE_MAX = 160
/** 100% 일 때의 루트 font-size */
const BASE_ROOT = 16

/** 배율 → 기대 루트 font-size (px). 반올림하지 않는다 — 실제값과 그대로 비교해야 한다. */
const expectedRoot = (scale) => `${BASE_ROOT * (scale / 100)}px`

export async function run(ctx) {
  await ctx.enrollLanguage('English')
  await ctx.createDocument(TEXT, 'English')
  await openDocument(ctx)

  const base = await readMetrics(ctx)
  ctx.check('기본 글자 크기가 100% 다', `${base.root}px` === expectedRoot(100),
    `html font-size ${base.root}px`)
  ctx.check('본문이 읽을 만한 크기다', base.body >= 16, `${base.body}px`)

  // ── 배율을 올린다 ──
  await ctx.clickSelector('a[href="/settings"]')
  await sleep(400)
  await setScale(ctx, 130)
  await openDocument(ctx)
  const big = await readMetrics(ctx)
  ctx.check('글자 크기가 커진다', big.body > base.body, `${base.body}px → ${big.body}px`)
  ctx.check('본문만 커지는 게 아니라 여백도 같이 커진다', big.lineHeight > base.lineHeight,
    `줄 간격 ${base.lineHeight}px → ${big.lineHeight}px`)

  // ── 가장 크게 ──
  await ctx.clickSelector('a[href="/settings"]')
  await sleep(400)
  await setScale(ctx, SCALE_MAX)
  await openDocument(ctx)
  const max = await readMetrics(ctx)
  ctx.check('최대 배율이 적용된다', `${max.root}px` === expectedRoot(SCALE_MAX),
    `html font-size ${max.root}px (기대 ${expectedRoot(SCALE_MAX)})`)
  ctx.check('가장 크게 키워도 가로로 넘치지 않는다', max.overflowX <= 1,
    `본문 폭 ${max.scrollWidth}px / 화면 ${max.viewport}px`)

  // ── 가장 작게 ──
  await ctx.clickSelector('a[href="/settings"]')
  await sleep(400)
  await setScale(ctx, SCALE_MIN)
  await openDocument(ctx)
  const min = await readMetrics(ctx)
  ctx.check('최소 배율이 적용된다', `${min.root}px` === expectedRoot(SCALE_MIN),
    `html font-size ${min.root}px (기대 ${expectedRoot(SCALE_MIN)})`)
  ctx.check('줄 간격도 줄에 맞춰 같이 줄어든다', min.lineHeight < base.lineHeight,
    `${min.lineHeight}px`)

  // ── 네비게이션이 한 줄로 유지되는지 (가로 스크롤은 허용) ──
  await ctx.clickSelector('a[href="/"]')
  await sleep(400)
  const nav = await ctx.page.evaluate(`(() => {
    const nav = document.querySelector('nav');
    if (!nav) return null;
    const r = nav.getBoundingClientRect();
    return { height: r.height, width: r.width, scroll: nav.scrollWidth };
  })()`)
  ctx.check('작게 키워도 네비 한 줄 유지', nav !== null && nav.height <= 60,
    `높이 ${nav?.height}px`)

  // ── 기본값 되돌리기 ──
  await ctx.clickSelector('a[href="/settings"]')
  await sleep(400)
  await resetControl(ctx, 'Text size')
  await sleep(300)
  const reset = await ctx.page.evaluate(`getComputedStyle(document.documentElement).fontSize`)
  ctx.check('기본값으로 되돌린다', reset === expectedRoot(100), `html font-size ${reset}`)

  // ── 새로고침 후에도 유지된다 ──
  await ctx.clickSelector('a[href="/settings"]')
  await sleep(400)
  await setScale(ctx, 115)
  await ctx.reload()
  await ctx.waitFor(`!!document.querySelector('a[href="/settings"]')`, '앱 재시작')
  await sleep(500)
  const kept = await ctx.page.evaluate(`getComputedStyle(document.documentElement).fontSize`)
  ctx.check('새로고침 후에도 유지된다', kept === expectedRoot(115), `html font-size ${kept}`)

  // ── 눈금 밖 값은 눈금 위로 ──
  await ctx.clickSelector('a[href="/settings"]')
  await sleep(400)
  await setScale(ctx, 500)
  const capped = await readScale(ctx)
  ctx.check('눈금을 넘겨도 최대값에서 멈춘다', Number(capped) === SCALE_MAX, `슬라이더 값 ${capped}`)
  const overRoot = await ctx.page.evaluate(`getComputedStyle(document.documentElement).fontSize`)
  ctx.check('범위를 넘겨도 깨지지 않는다', overRoot === expectedRoot(SCALE_MAX),
    `html font-size ${overRoot} (기대 ${expectedRoot(SCALE_MAX)})`)
}

/** 설정 화면에는 문서 링크가 없으므로 홈으로 나갔다가 문서를 연다 */
async function openDocument(ctx) {
  const onReader = await ctx.page.evaluate(`!!document.querySelector('[data-start]')`)
  if (!onReader) {
    await ctx.clickSelector('a[href="/"]')
    await sleep()
  }
  await ctx.page.evaluate(
    `[...document.querySelectorAll('a')].find(x=>x.getAttribute('href')?.startsWith('/read/'))?.click(); true`,
  )
  await ctx.waitFor(`!!document.querySelector('[data-start]')`, '본문')
  await sleep(400)
}

async function readMetrics(ctx) {
  return ctx.page.evaluate(`(() => {
    const word = [...document.querySelectorAll('[data-start]')].find(x => x.textContent === 'busy');
    const body = getComputedStyle(document.querySelector('[data-start]').parentElement);
    return {
      root: parseFloat(getComputedStyle(document.documentElement).fontSize),
      body: word ? parseFloat(getComputedStyle(word).fontSize) : null,
      lineHeight: parseFloat(body.lineHeight),
      scrollWidth: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
    };
  })()`)
}

/**
 * 글자 크기 슬라이더만 건드린다.
 * 위치에 의존하지 않기 위해 최대값(160)으로 찾아낸다 — 설정 순서가 바뀌어도
 * 옅은 정도 슬라이더를 잘못 건드리지 않는다.
 */
async function setScale(ctx, value) {
  return ctx.page.evaluate(`(() => {
    const r = [...document.querySelectorAll('input[type="range"]')].find(x => Number(x.max) === ${SCALE_MAX});
    if (!r) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(r, '${value}');
    r.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
}

async function readScale(ctx) {
  return ctx.page.evaluate(`(() => {
    const r = [...document.querySelectorAll('input[type="range"]')].find(x => Number(x.max) === ${SCALE_MAX});
    return r ? Number(r.value) : null;
  })()`)
}

/** 이름이 붙은 설정의 기본값 버튼을 누른다 */
async function resetControl(ctx, label) {
  return ctx.page.evaluate(`(() => {
    const target = [...document.querySelectorAll('p')].find(p => p.innerText.trim() === ${JSON.stringify(label)});
    const section = target?.closest('div')?.parentElement;
    const btn = [...(section?.querySelectorAll('button') ?? [])].find(b => b.innerText.trim() === 'Reset');
    if (!btn) return false;
    btn.click();
    return true;
  })()`)
}

function sleep() {
  return new Promise((r) => setTimeout(r, 400))
}
