/**
 * 여러 언어를 한 번에 고르고, 배운 언어 / 배우지 않는 언어로 나눠 보여 준다.
 *
 * 회귀: 언어를 하나 고르면 곧바로 다음 화면으로 넘어갔다. 고르는 중에도 저장이 되므로
 * 계단식으로 튕겨 나갔고, 여러 개를 고를 수 없었다.
 */

export async function run(ctx) {
  /** 온보딩 화면을 연다 — 언어를 하나도 고르지 않은 첫 실행 상태여야 한다 */
  const openOnboarding = async () => {
    await ctx.page.evaluate(`(() => {
      localStorage.removeItem('lexi.languages');
      return true;
    })()`)
    await ctx.page.evaluate(`location.reload(); true`)
    await sleep(1200)
    await ctx.waitFor(`!![...document.querySelectorAll('h1')].find(h => /Choose what you want to learn|배울 언어/i.test(h.innerText))`, '온보딩')
  }

  await openOnboarding()

  const pick = async (name) => {
    const ok = await ctx.page.evaluate(`(() => {
      const b = [...document.querySelectorAll('ul li button')].find(x => x.innerText.includes(${JSON.stringify(name)}));
      if (!b) return false;
      b.click();
      return true;
    })()`)
    if (!ok) throw new Error(`언어를 찾지 못함: ${name}`)
    await sleep(250)
    return ok
  }

  /**
   * 언어 버튼만 세어야 한다.
   *
   * `aria-pressed` 를 쓰는 다른 곳(상단 앱 언어 전환)이 섞이면 계���가 어긋난다.
   * 언어 목록은 항상 ul 안의 li 안에 있다.
   */
  const selectedLanguages = () => ctx.page.evaluate(`(() => {
    return [...document.querySelectorAll('ul li button[aria-pressed="true"]')]
      .map(b => b.innerText.split('\\n')[0].trim());
  })()`)

  const state = async () => ctx.page.evaluate(`(() => {
    const text = document.body.innerText;
    return {
      stillOnboarding: /Choose what you want to learn|배울 언어/i.test(text),
      selected: [...document.querySelectorAll('ul li button[aria-pressed="true"]')].map(b => b.innerText.split('\\n')[0].trim()),
      mine: /내가 배우는 언어|Languages I study/.test(text),
      others: /배우지 않는 언어|Not studying/.test(text),
      done: /시작하기|Start with these/.test(text),
    };
  })()`)

  const first = await state()
  ctx.check('처음에는 아무것도 선택되어 있지 않다', first.selected.length === 0, JSON.stringify(first))

  await pick('한국어')
  const afterOne = await state()
  ctx.check('하나를 골라도 넘어가지 않는다', afterOne.stillOnboarding === true, JSON.stringify(afterOne))
  ctx.check('고른 언어는 표시된 상태다', afterOne.selected.length === 1, JSON.stringify(afterOne.selected))

  await pick('English')  // 고유 라벨은 UI 언어와 무관하다
  await pick('Français')
  await pick('Deutsch')
  const afterMany = await state()
  ctx.check('여러 개를 골라도 넘어가지 않는다', afterMany.stillOnboarding === true, JSON.stringify(afterMany))
  ctx.check('네 개가 선택되었다', afterMany.selected.length === 4, JSON.stringify(afterMany.selected))

  /** 배운 언어 / 배우지 않는 언어로 나뉘어야 지금 무엇을 배우는지 한눈에 들어야 한다 */
  ctx.check('내가 배우는 언어 섹션이 생긴다', afterMany.mine === true, JSON.stringify(afterMany))
  ctx.check('배우지 않는 언어 섹션이 생긴다', afterMany.others === true, JSON.stringify(afterMany))

  /**
   * 섹션별로 센다 — '제목 바로 다음 목록' 이 그 섹션의 목록이다.
   * 바깥 section 을 통째로 세면 다른 섹션의 목록까지 딸려 들어온다.
   */
  const sections = await ctx.page.evaluate(`(() => {
    const out = [];
    for (const h2 of document.querySelectorAll('h2')) {
      let node = h2.nextElementSibling;
      while (node && node.tagName !== 'UL' && node.tagName !== 'P') node = node.nextElementSibling;
      out.push({
        heading: h2.innerText.trim(),
        count: node && node.tagName === 'UL' ? node.querySelectorAll('li').length : 0,
      });
    }
    return out;
  })()`)
  ctx.check('두 섹션으로 나뉘어 있다', sections.length === 2, JSON.stringify(sections))
  ctx.check('배우는 쪽에 고른 개수만큼 보인다', sections[0]?.count === 4, JSON.stringify(sections))
  ctx.check('나머지 언어가 다른 쪽에 있다', sections[1]?.count === 4, JSON.stringify(sections))

  const done = await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /시작하기|Start with these/.test(x.innerText));
    if (!b) return false;
    if (b.disabled) return 'disabled';
    b.click();
    return true;
  })()`)
  ctx.check('마치는 버튼이 눌린다', done === true, String(done))
  await sleep(800)

  const after = await state()
  ctx.check('마쳐야 넘어간다', after.stillOnboarding === false, JSON.stringify(after))

  // 홈 화면에는 언어 목록이 없다 — 배운 언어는 메뉴에서 확인한다
  await ctx.clickSelector('a[href="/languages"]')
  await sleep(700)
  ctx.check('마친 뒤에도 고른 언어는 남는다', (await selectedLanguages()).length === 4,
    JSON.stringify(await selectedLanguages()))

  /** 언어 메뉴에서도 두 섹션이 유지된다 */
  await ctx.clickSelector('a[href="/languages"]')
  await sleep(700)
  const menu = await ctx.page.evaluate(`(() => {
    const text = document.body.innerText;
    return {
      mine: /내가 배우는 언어|Languages I study/.test(text),
      others: /배우지 않는 언어|Not studying/.test(text),
      selected: document.querySelectorAll('ul li button[aria-pressed="true"]').length,
    };
  })()`)
  ctx.check('언어 메뉴에서도 두 섹션이다', menu.mine && menu.others, JSON.stringify(menu))
  ctx.check('선택된 언어가 표시되어 있다', menu.selected === 4, JSON.stringify(menu))

  /** 새로고침해도 유지된다 */
  await ctx.page.evaluate(`location.reload(); true`)
  await sleep(1200)
  await ctx.clickSelector('a[href="/languages"]')
  await sleep(700)
  const afterReload = await ctx.page.evaluate(`document.querySelectorAll('ul li button[aria-pressed="true"]').length`)
  ctx.check('새로고침해도 선택이 남는다', afterReload === 4, String(afterReload))
}

function sleep(ms = 400) {
  return new Promise((r) => setTimeout(r, ms))
}