/** 테마 10종과 반응형 레이아웃 — 색이 실제로 테마를 따르고 잘 읽히는지 */

const THEMES = ['White', 'Sepia', 'Matcha', 'Latte', 'Black', 'Monaspace', 'Dracula', 'Monokai', 'Tokyo Night', 'Nord']
const TEXT = `Ubiquitous smartphones changed communication.
Dr. Smith measured 3.14 metres of wire.`

/** WCAG 상대 휘도 대비 */
function contrast(fg, bg) {
  const lum = (hex) => {
    const v = hex.replace('#', '')
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255)
    const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}

export async function run(ctx) {
  await ctx.enrollLanguage('English')
  await ctx.createDocument(TEXT, 'English')

  // 상태 색이 실제로 쓰이도록 표시를 해둔다
  await ctx.clickWord('Ubiquitous')
  await sleep()
  await ctx.setStatus('New')
  await ctx.pressEscape()
  await ctx.clickWord('measured')
  await sleep()
  await ctx.setStatus('Unsure')
  await ctx.pressEscape()

  // 테마 선택 화면 진입
  await ctx.clickSelector('a[href="/settings"]')
  await sleep()
  const themeCount = await ctx.page.evaluate(`document.querySelectorAll('ul li button').length`)
  ctx.check('설정 화면에 테마 10개가 보인다', themeCount === 10, `${themeCount}개`)

  const report = []
  for (const label of THEMES) {
    await ctx.selectTheme(label)
    const probe = await ctx.page.evaluate(`(() => {
      const cs = getComputedStyle(document.documentElement);
      const pick = (n) => cs.getPropertyValue(n).trim();
      return {
        theme: document.documentElement.dataset.theme,
        bg: pick('--t-bg'),
        ink: pick('--t-ink'),
        accent: pick('--t-accent'),
        unknown: pick('--t-status-unknown'),
        unsure: pick('--t-status-unsure'),
        chrome: document.querySelector('meta[name="theme-color"]')?.content,
      };
    })()`)

    const ratios = {
      ink: contrast(probe.ink, probe.bg),
      accent: contrast(probe.accent, probe.bg),
      unknown: contrast(probe.unknown, probe.bg),
      unsure: contrast(probe.unsure, probe.bg),
    }
    report.push({ label, ...ratios, probe })

    const expectedId = label.toLowerCase().replace(/ /g, '-')
    ctx.check(
      `${label.padEnd(11)} 대비 본문 ${ratios.ink.toFixed(2)} · 강조 ${ratios.accent.toFixed(2)} · 모름 ${ratios.unknown.toFixed(2)} · 헷갈림 ${ratios.unsure.toFixed(2)}`,
      probe.theme === expectedId &&
        ratios.ink >= 4.5 &&
        ratios.accent >= 3 &&
        ratios.unknown >= 4.5 &&
        ratios.unsure >= 3,
      `data-theme=${probe.theme}`,
    )
    ctx.check(`  ${label} theme-color 가 동기화된다`, probe.chrome === probe.bg)
  }

  const failing = report.filter((r) => r.probe.theme === '')
  if (failing.length > 0) ctx.check('테마가 하나라도 적용되지 않음', false, failing.map((r) => r.label).join(', '))

  // 어두운 테마에서 상태 색이 테마를 따른다
  await ctx.selectTheme('Nord')
  await ctx.clickSelector('a[href="/"]')
  await sleep(400)
  await ctx.page.evaluate(
    `[...document.querySelectorAll('a')].find(x=>x.getAttribute('href')?.startsWith('/read/'))?.click(); true`,
  )
  await ctx.waitFor(`!!document.querySelector('[data-start]')`, '본문')
  await sleep(600)
  const colors = await ctx.page.evaluate(`(() => {
    const pick = (w) => {
      const el = [...document.querySelectorAll('[data-start]')].find(e => e.textContent === w);
      return el ? getComputedStyle(el).color : null;
    };
    return { unknown: pick('Ubiquitous'), unsure: pick('measured'), plain: pick('wire'), body: getComputedStyle(document.body).backgroundColor };
  })()`)
  ctx.check('Nord 에서 상태 색이 본문과 구분된다',
    colors.unknown !== colors.plain && colors.unsure !== colors.plain, JSON.stringify(colors))
  ctx.check('Nord 배경이 테마 값과 일치한다', colors.body === 'rgb(46, 52, 64)', colors.body)

  // ── 반응형 네비게이션 ──
  for (const [width, height, label] of [[420, 900, '모바일'], [360, 780, '안드로이드'], [320, 700, '좁은 화면']]) {
    await ctx.setViewport(width, height)
    await sleep(300)
    const nav = await ctx.page.evaluate(`(() => {
      const box = document.querySelector('nav > div');
      return {
        height: Math.round(box.getBoundingClientRect().height),
        wrapped: [...box.children].some(c => c.getBoundingClientRect().height > 30),
        scrolls: box.scrollWidth > box.clientWidth,
      };
    })()`)
    ctx.check(`${label} ${width}px: 네비 한 줄 유지`, nav.height <= 60 && !nav.wrapped,
      `높이 ${nav.height}px${nav.scrolls ? ' (가로 스크롤)' : ''}`)
  }

  await ctx.setViewport(420, 900)
}

function sleep() {
  return new Promise((r) => setTimeout(r, 400))
}