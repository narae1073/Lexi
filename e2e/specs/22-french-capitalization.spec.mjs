/**
 * 문장 첫 단어의 대문자와 고유명사.
 *
 * 눈에 보이는 차이는 위치다 — 첫머리 대문자는 위치에서 오고, 고유명사 대문자는
 * 어디서나 온다. 그래서 콜론·여는 따옴표·대시 뒤의 대문자도 '위치에서 온 것' 으로
 * 세어야 `Pour` 와 `pour` 가 한 단어로 남는다.
 */

const FR = `Pour comprendre, il faut lire.
Voici : Pour une fois, la réponse est simple.
« Pour demain, dit-il, il faut partir. »
Le chat dort et n'est pas pressé.
J'aime d'été et l'eau.
Paris est loin. Je vais à Paris.
US and us do not differ in this example.
The US economy grew. Tell us about it.`

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
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Capitalisation');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await sleep(200)
  await ctx.typeIntoTextarea(FR)
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
  // 진도 계산이 끝날 때까지 기다린다 — 등장 기록이 모여야 고유 단어 수가 나온다
  await sleep(2500)

  const state = await ctx.page.evaluate(`(() => {
    const aside = document.querySelector('aside');
    const text = document.body.innerText;
    const words = text.match(/(\\d+)\\s+words/);
    return { words: words ? Number(words[1]) : null, hasBar: !!aside };
  })()`)
  ctx.check('고유 단어 수가 나온다', typeof state.words === 'number', JSON.stringify(state))

  /**
   * 단어장에서 본다 — 진도 계산이 '같은 단어' 를 어떻게 셌는지 가장 직접적으로 드러난다.
   */
  await ctx.page.evaluate(`(() => {
    const a = [...document.querySelectorAll('a')].find(x => x.getAttribute('href') === '/wordbook');
    a.click();
    return true;
  })()`)
  await sleep(1000)

  /**
   * 검색으로 좁혀 본다 — 단어장은 한 쪽에 20개씩이라 앞쪽에 없으면 '없다' 고 오해한다.
   */
  const wordsMatching = async (term) => {
    await ctx.page.evaluate(`(() => {
      const i = document.querySelector('input[placeholder]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(i, ${JSON.stringify(term)});
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    await sleep(500)
    return ctx.page.evaluate(`(() => {
      return [...document.querySelectorAll('li')]
        .map(li => li.querySelector('[data-wordbook-lemma]')?.innerText?.trim() ?? '')
        .filter(Boolean);
    })()`)
  }

  const pour = await wordsMatching('pour')
  ctx.check('Pour 와 pour 가 한 항목이다',
    pour.includes('pour') && !pour.includes('Pour'), JSON.stringify(pour))

  const paris = await wordsMatching('paris')
  ctx.check('고유명사 Paris 는 분리된다',
    paris.includes('Paris') && !paris.includes('paris'), JSON.stringify(paris))

  const ete = await wordsMatching('été')
  ctx.check('축약은 원형으로 모인다',
    ete.includes('été'), JSON.stringify(ete))
}

function sleep(ms = 400) {
  return new Promise((r) => setTimeout(r, ms))
}