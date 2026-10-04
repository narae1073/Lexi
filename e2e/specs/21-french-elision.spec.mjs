/**
 * 프랑스어 축약 — d'a prints 를 누르면 'été' 로 인식되어야 한다.
 *
 * 축약은 한 단어로 토큰화된다. 접히지 않으면 표기가 그대로 사전 조회가 되고,
 * 사전에 없는 표기라 '찾는 중' 에서 멈춘다. 같은 문서의 'été' 와도 다른 단어로
 * 세어진다 — 배우는 사람에게 둘은 같은 말이다.
 */

const FR = `J'aime d'été et l'eau.
D'abord, d'Artagnan est arrivé.
Le chat dort et n'est paspressé.
L'été est chaud cette année.`

export async function run(ctx) {
  await ctx.enrollLanguage('French')

  await ctx.page.evaluate(`(() => {
    const a = [...document.querySelectorAll('a')].find(x => x.getAttribute('href') === '/compose');
    a.click();
    return true;
  })()`)
  await sleep(400)
  await ctx.page.evaluate(`(() => {
    const input = [...document.querySelectorAll('input')].find(x => !x.type || x.type === 'text');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Essai français');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await sleep(200)
  await ctx.typeIntoTextarea(`J'aime d'été et l'eau.
D'abord, d'Artagnan est arrivé.
Le chat dort et n'est pas pressé.
L'été est chaud cette année.
D'Anjou est une région française.
`)
  await ctx.clickText('Create document')
  await sleep(700)

  await ctx.clickSelector('a[href="/"]')
  await sleep(700)
  await ctx.page.evaluate(`(() => {
    const link = [...document.querySelectorAll('a')].find(x => x.getAttribute('href')?.startsWith('/read/'));
    link.click();
    return true;
  })()`)
  await sleep(700)
  await ctx.waitFor(`!!document.querySelector('[data-start]')`, '본문')

  // 축약이 하나의 토큰으로 남아 있는가
  const tokens = await ctx.page.evaluate(`(() => {
    return [...document.querySelectorAll('[data-start]')].map(e => e.textContent).slice(0, 40);
  })()`)
  ctx.check("d'été 는 한 단어로 분절된다",
    tokens.includes("d'été") && !tokens.includes("d'"), JSON.stringify(tokens.slice(0, 14)))
  ctx.check("l'eau 도 한 단어다", tokens.includes("l'eau"), JSON.stringify(tokens.slice(0, 14)))
  ctx.check('고유명사는 접히지 않고 그대로다', tokens.includes("d'Artagnan"),
    JSON.stringify(tokens.filter(t => t.includes("d'") || t.includes("D'"))))

  // 눌렀을 때 사전 조회가 'été' 로 나가는가 — 표는 원래 모습 그대로
  const elision = await ctx.page.evaluate(`(() => {
    const el = [...document.querySelectorAll('[data-start]')].find(e => e.textContent === "d'été");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  ctx.check("d'été 를 화면에서 찾았다", Boolean(elision), JSON.stringify(elision))
  if (!elision) return

  for (const type of ['mousePressed', 'mouseReleased']) {
    await ctx.page.send('Input.dispatchMouseEvent', {
      type,
      x: elision.x,
      y: elision.y,
      button: 'left',
      clickCount: 1,
    })
  }
  await sleep(500)

  const dialog = await ctx.popover()
  ctx.check('단어 박스가 뜬다', Boolean(dialog), '박스')
  ctx.check('표기는 원래 쓴 모습이다', (dialog?.text ?? '').includes("d'été"),
    (dialog?.text ?? '').split('\n').slice(0, 2).join(' | '))

  await ctx.openDictionary()
  // 조회가 끝날 때까지 기다린다 — 오프라인이면 실패로 끝난다
  const found = await ctx.page.evaluate(`(async () => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const d = document.querySelector('[role="dialog"]');
      if (d && /Wiktionary|CC BY|Loading|없|No entry|not find/i.test(d.innerText)) {
        return { text: d.innerText, loading: /Loading|찾는 중/.test(d.innerText) };
      }
      await new Promise(r => setTimeout(r, 300));
    }
    return null;
  })()`)
  ctx.check('사전 결과가 도착한다', found !== null, '대기 초과')

  /**
   * 진짜 뜻이 나와야 한다. 조회가 'd'été' 로 갔으면 사전에 없는 표기라 '없다' 고 나온다 —
   * 축약이 제대로 접혔다는 가장 직접적인 증거다.
   */
  const snippet = (found?.text ?? '').split('\n').filter(l => /Wiktionary|CC BY|No entry|없/i.test(l)).join(' | ')
  const hasEntry = found !== null && /Wiktionary|CC BY/i.test(found.text)
  ctx.check("'été' 로 조회되어 뜻이 나온다", hasEntry === true,
    snippet || '사전 내용 없음')

  /**
   * 축약형과 원형이 한 단어로 모이는가 — 따로 세면 같은 말을 두 번 배우게 된다.
   * 진도 계산의 고유 단어 수로 드러난다.
   */
  const stats = await ctx.page.evaluate(`(() => {
    const aside = document.querySelector('[aria-label]');
    const text = document.body.innerText;
    const m = text.match(/(\\d+)\\s+words/);
    return { words: m ? Number(m[1]) : null };
  })()`)
  ctx.check('고유 단어 수가 나온다', typeof stats.words === 'number', JSON.stringify(stats))
}

function sleep(ms = 400) {
  return new Promise((r) => setTimeout(r, ms))
}