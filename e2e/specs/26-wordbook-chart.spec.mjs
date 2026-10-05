/**
 * 단어장 상단의 상태 게이지.
 *
 * 미표시 / 앎 / 헷갈림 / 모름 을 한 줄로 쌓고, 각 상태가 전체에서 몇 % 인지 아래에
 * 적는다. 폭과 아래 숫자는 같은 숫자에서 나야 한다 — 따로 계산하면 어긋난다.
 */

const TEXT = `The policy is written in a document.
Every policy needs a careful review of its wording.
The committee revised the policy last spring.
A policy that nobody reads is useless.
Some clauses in the policy remain unclear.
We should rewrite the policy carefully.`

export async function run(ctx) {
  await ctx.enrollLanguage('English')
  await ctx.createDocument(TEXT)
  await sleep(2500)

  await ctx.page.evaluate(`(() => {
    const a = [...document.querySelectorAll('a')].find(x => x.getAttribute('href') === '/wordbook');
    a.click();
    return true;
  })()`)
  await sleep(1000)

  /**
   * 상태를 먼저 몇 개 표시해야 두 번째 구간이 생긴다.
   *
   * 하나도 표시하지 않은 상태에서检查하면 '다음 구간이 무엇인지' 를 볼 수 없다 —
   * 없는 것을 확인하는 것뿐이다.
   */
  const marked = await ctx.page.evaluate(`(() => {
    // 상태 버튼은 aria-label 로 구분된다 — 본문 글자와 헷갈리지 않게
    // 차트 설명도 li 다 — 상태 버튼이 있는 행만 고른다
    const rows = [...document.querySelectorAll('li')].filter(r => r.querySelector('button[aria-label]'));
    const click = (row, label) => {
      const b = [...row.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === label);
      if (!b) return false;
      b.click();
      return true;
    };
    let done = 0;
    if (click(rows[0], 'Know it')) done++;
    if (rows[1] && click(rows[1], 'Unsure')) done++;
    if (rows[2] && click(rows[2], 'Do not know')) done++;
    return done;
  })()`)
  ctx.check('세 개의 상태를 표시했다', marked === 3, String(marked))
  await sleep(900)

  const chart = await ctx.page.evaluate(`(() => {
    const bar = document.querySelector('[role="img"]');
    if (!bar) return null;
    const width = bar.getBoundingClientRect().width;
    const segments = [...bar.children].map(s => ({
      percent: Math.round((s.getBoundingClientRect().width / width) * 100),
      className: s.className,
    }));
    const legend = [...bar.parentElement.querySelectorAll('li')].map(li => ({
      label: li.querySelector('.whitespace-nowrap')?.innerText ?? '',
      text: li.innerText.replace(/ +/g, ' ').trim(),
    }));
    const legendHtml = bar.parentElement.querySelector('ul li')?.outerHTML ?? '';
    return { label: bar.getAttribute('aria-label'), segments, legend, legendHtml, barHeight: Math.round(bar.getBoundingClientRect().height) };
  })()`)

  ctx.check('게이지가 보인다', chart !== null, JSON.stringify(chart))
  ctx.check('막대가 있다', chart !== null && chart.barHeight > 0, JSON.stringify(chart))

  /**
   * 요청한 순서: 미표시 → 앎 → 헷갈림 → 모름.
   * 색은 상태 표시와 같은 규칙을 쓴다 — 아는 단어는 본문색이다.
   */
  ctx.check('미표시가 먼저 온다',
    chart?.segments?.[0]?.className.includes('unmarked') === true, JSON.stringify(chart?.segments))
  ctx.check('그 다음이 앎이고 본문색이다',
    chart?.segments?.[1]?.className.includes('bg-ink') === true, JSON.stringify(chart?.segments))
  ctx.check('그 다음이 헷갈림이다',
    chart?.segments?.[2]?.className.includes('unsure') === true, JSON.stringify(chart?.segments))
  ctx.check('그 다음이 모름이다',
    chart?.segments?.[3]?.className.includes('unknown') === true, JSON.stringify(chart?.segments))

  /** 아래 설명에 각 상태의 개수와 % 가 함께 있어야 한다 */
  ctx.check('아래에 각 상태의 % 가 적힌다',
    (chart?.legend ?? []).length === 4 && chart.legend.every((l) => /%/.test(l.text)),
    JSON.stringify(chart?.legend))

  /** 라벨이 어절 중간에 깨지지 않는다 — 좁은 화면에서flex 가 글자를 쪼갤 수 있다 */
  ctx.check('라벨이 깨지지 않는다',
    (chart?.legend ?? []).every((l) => !/\s/.test(l.label)),
    JSON.stringify((chart?.legend ?? []).map((l) => l.label)))

  /** 네 개를 더하면 정확히 100 이어야 한다 — 따로 반올림하면 101 이 된다 */
  const sum = (chart?.legend ?? []).reduce((acc, line) => {
    const m = line.text.match(/(\d+)%/)
    return acc + (m ? Number(m[1]) : 0)
  }, 0)
  ctx.check('네 개가 정확히 100 이다', sum === 100, `${sum} — ${JSON.stringify(chart?.legend)}`)

  /** 막대 폭과 아래 숫자가 같은 숫자여야 한다 */
  const shares = (chart?.segments ?? []).map((s) => s.percent)
  const labeled = (chart?.legend ?? []).map((l) => Number(l.text.match(/(\d+)%/)?.[1] ?? -1)).filter((n) => n > 0)
  ctx.check('막대 폭이 설명과 같다', JSON.stringify(shares) === JSON.stringify(labeled),
    `막대 ${JSON.stringify(shares)} · 설명 ${JSON.stringify(labeled)}`)

  /** 상태를 바꾸면 따라간다 — 목록이 상태별로 갈라져 있으니 '미표시' 탭으로 간다 */
  await ctx.page.evaluate(`(() => {
    const tab = [...document.querySelectorAll('button[aria-pressed]')].find(b => /Unmarked/.test(b.innerText));
    if (tab && tab.getAttribute('aria-pressed') === 'false') tab.click();
    return true;
  })()`)
  await sleep(700)
  const changed = await ctx.page.evaluate(`(() => {
    const list = [...document.querySelectorAll('li')].filter(r => r.querySelector('button[aria-label]'));
    const row = list.find(r =>
      [...r.querySelectorAll('button')].every(x => x.getAttribute('aria-pressed') !== 'true'));
    if (!row) return false;
    const b = [...row.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === 'Know it');
    if (!b) return false;
    b.click();
    return true;
  })()`)
  ctx.check('미표시 행을 골랐다', changed === true, String(changed))
  await sleep(900)

  const afterMark = await ctx.page.evaluate(`(() => {
    const bar = document.querySelector('[role="img"]');
    if (!bar) return null;
    const width = bar.getBoundingClientRect().width;
    return [...bar.children].map(s => Math.round((s.getBoundingClientRect().width / width) * 100));
  })()`)
  ctx.check('상태를 바꾸면 막대가 따라간다', JSON.stringify(afterMark) !== JSON.stringify(shares),
    `${JSON.stringify(shares)} → ${JSON.stringify(afterMark)}`)
}

function sleep(ms = 400) {
  return new Promise((r) => setTimeout(r, ms))
}