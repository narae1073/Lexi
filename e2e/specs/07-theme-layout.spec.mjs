/** 테마 10종과 반응형 레이아웃 — 색이 실제로 테마를 따르고 잘 읽히는지 */

const THEMES = ['White', 'Sepia', 'Matcha', 'Latte', 'Black', 'Monaspace', 'Dracula', 'Monokai', 'Tokyo Night', 'Nord']
const TEXT = `Ubiquitous smartphones changed communication.
Dr. Smith measured 3.14 metres of wire.`

/** WCAG 상대 휘도 대비 — 빌드가 #ffffff 를 #fff 로 줄이므로 세 자리도 받는다 */
function contrast(fg, bg) {
  const lum = (hex) => {
    let v = hex.replace('#', '')
    if (v.length === 3) v = [...v].map((c) => c + c).join('')
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255)
    const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}

/**
 * 첫 문서를 열어 본문 화면으로 간다.
 * 설정 화면에는 문서 링크가 없으므로 홈으로 나갔다가 들어가야 하고,
 * 문서 링크는 /read/<id> 형태라 beginswith 로 눌러야 한다.
 */
async function openDocument(ctx) {
  await ctx.clickSelector('a[href="/"]')
  await sleep(400)
  await ctx.page.evaluate(
    `[...document.querySelectorAll('a')].find(x=>x.getAttribute('href')?.startsWith('/read/'))?.click(); true`,
  )
  await ctx.waitFor(`!!document.querySelector('[data-start]')`, '본문')
  await sleep(400)
}

/** 본문에서 표시 안 한 단어의 실제 렌더 색 */
async function readShade(ctx) {
  return ctx.page.evaluate(`(() => {
    const n = [...document.querySelectorAll('[data-start]')].find(x => x.textContent === 'changed');
    return n ? getComputedStyle(n).color : null;
  })()`)
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

  // ── 표시 안 한 단어는 아는 단어보다 옅게 보인다 ──
  // 'wire' 를 아는 단어로 만든다 (Ubiquitous 는 위에서 ● 로 칠했다)
  await openDocument(ctx)
  // 3.14 의 숫자는 단어가 아니라 팝오버가 열리지 않는다
  ctx.check('숫자는 단어가 아니다', (await ctx.clickWord('3')) === false && (await ctx.popover()) === null)
  await ctx.clickWord('wire')
  await sleep()
  await ctx.setStatus('Know')
  await ctx.pressEscape()
  const shade = await ctx.page.evaluate(`(() => {
    const read = (t) => {
      const n = [...document.querySelectorAll('[data-start]')].find(x => x.textContent === t);
      return n ? getComputedStyle(n).color : null;
    };
    return { unmarked: read('changed'), known: read('wire'), ink: getComputedStyle(document.body).color };
  })()`)
  ctx.check('표시 안 한 단어가 아는 단어보다 옅다',
    shade.unmarked !== null && shade.unmarked !== shade.known,
    `미표시 ${shade.unmarked} / 알음 ${shade.known}`)
  ctx.check('아는 단어는 본문색 그대로다', shade.known === shade.ink,
    `알음 ${shade.known} / 본문 ${shade.ink}`)

  // ── 설정에서 옅은 정도를 조절한다 ──
  await ctx.clickSelector('a[href="/settings"]')
  await sleep(500)
  // 최대값으로 찾아낸다 — 설정 순서가 바뀌어도 글자 크기 슬라이더를 건드리지 않게
  const setDim = (v) => ctx.page.evaluate(`(() => {
    const r = [...document.querySelectorAll('input[type="range"]')].find(x => Number(x.max) === 70);
    if (!r) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(r, '${v}');
    r.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)

  await openDocument(ctx)
  const faint = await readShade(ctx)
  await ctx.clickSelector('a[href="/settings"]')
  await sleep(400)
  await setDim(0)
  await openDocument(ctx)
  const full = await readShade(ctx)
  ctx.check('슬라이더로 옅은 정도가 바뀐다', faint !== full, `기본 ${faint} → 0% ${full}`)

  await ctx.clickSelector('a[href="/settings"]')
  await sleep(400)
  await setDim(70)
  await openDocument(ctx)
  const faintest = await readShade(ctx)
  ctx.check('크게 옅게 하면 아는 단어와 확실히 다르다', faintest !== full, `${faintest} vs ${full}`)

  await ctx.clickSelector('a[href="/settings"]')
  await sleep(400)
  await ctx.page.evaluate(`(() => {
    const target = [...document.querySelectorAll('p')].find(p => p.innerText.trim() === 'Unmarked word shade');
    const section = target?.closest('div')?.parentElement;
    [...(section?.querySelectorAll('button') ?? [])].find(b => b.innerText.trim() === 'Reset')?.click();
    return true;
  })()`)
  await sleep(300)

  await ctx.clickSelector('a[href="/settings"]')
  await sleep(500)

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
        accentInk: pick('--t-accent-ink'),
        unknown: pick('--t-status-unknown'),
        unsure: pick('--t-status-unsure'),
        chrome: document.querySelector('meta[name="theme-color"]')?.content,
      };
    })()`)

    const ratios = {
      ink: contrast(probe.ink, probe.bg),
      accent: contrast(probe.accent, probe.bg),
      // 선택된 카드·버튼의 글자색 — 언어 선택 화면의 자막이 묻히던 회귀
      accentInk: contrast(probe.accentInk, probe.accent),
      unknown: contrast(probe.unknown, probe.bg),
      unsure: contrast(probe.unsure, probe.bg),
    }
    report.push({ label, ...ratios, probe })

    const expectedId = label.toLowerCase().replace(/ /g, '-')
    ctx.check(
      `${label.padEnd(11)} 대비 본문 ${ratios.ink.toFixed(2)} · 강조 ${ratios.accent.toFixed(2)} · 강조글자 ${ratios.accentInk.toFixed(2)} · 모름 ${ratios.unknown.toFixed(2)} · 헷갈림 ${ratios.unsure.toFixed(2)}`,
      probe.theme === expectedId &&
        ratios.ink >= 4.5 &&
        ratios.accent >= 3 &&
        ratios.accentInk >= 4.5 &&
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