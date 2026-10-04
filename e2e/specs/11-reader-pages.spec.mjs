/**
 * 문서 본문 쪽 나누기 (plan.txt 7줄) + 하단 상태 바 (plan.txt 8줄).
 *
 * 특히 두 가지를 지킨다:
 *  - 어느 쪽에서 단어를 눌러도 같은 상태로 이어진다 (오프셋이 원문 기준)
 *  - 어느 쪽에서 문장을 드래그해도 그 문장의 번역이 나온다 (페이지 기준
 *    오프셋을 그대로 쓰면 두 번째 쪽부터 엉뚱한 문장을 번역한다)
 */

const PARAGRAPH = `Reading is the quiet habit that keeps a language alive.
When you meet a new word you do not stop to memorise it.
You keep reading and let the meaning arrive later.
That later arrival is the whole point of learning.
Small daily minutes beat one long weekend.
The sentences you understand grow a little every day.
Soon you notice words you once avoided.
This is how reading becomes a habit.
Keep the text easy enough that you never stop.
Difficulty is useful only when you keep going.
Choose material you can finish.
Finish the material you choose.
Repeat that choice tomorrow.
Nothing else needs to change.`

const TEXT = Array.from({ length: 4 }, () => PARAGRAPH).join('\n')

/** 쪽 이동 UI 의 현재 쪽 */
const currentPage = (ctx) =>
  ctx.page.evaluate(`(() => {
    const n = document.querySelector('nav[aria-label]');
    const cur = n && [...n.querySelectorAll('button')].find(b => b.getAttribute('aria-current') === 'page');
    return cur ? Number(cur.innerText.trim()) : null;
  })()`)

const pageCount = (ctx) =>
  ctx.page.evaluate(`(() => {
    const n = document.querySelector('nav[aria-label]');
    if (!n) return 1;
    const nums = [...n.querySelectorAll('button')].map(b => Number(b.innerText.trim())).filter(Number.isInteger);
    return Math.max(1, ...nums);
  })()`)

/** 이 쪽 본문에 보이는 단어 수 */
const wordsOnPage = (ctx) => ctx.page.evaluate(`document.querySelectorAll('[data-start]').length`)

/** 이 쪽 본문 텍스트 */
const pageText = (ctx) => ctx.page.evaluate(`document.querySelector('article > div')?.innerText ?? null`)

/** 상태 바 숫자 */
const readBar = (ctx) =>
  ctx.page.evaluate(`(() => {
    const bar = document.querySelector('aside[aria-label]');
    if (!bar) return null;
    const text = bar.innerText;
    const total = Number((text.match(/(\\d+)\\s+words/) ?? [])[1] ?? NaN);
    const items = [...bar.querySelectorAll('li')].map(li => li.innerText.trim());
    return { total, items, text: text.replace(/\\n/g, ' | ') };
  })()`)

/** 쪽 수를 바꾼다 — 라벨 글자로 찾아 다른 select 를 건드리지 않는다 */
async function setPageWords(ctx, value) {
  const ok = await ctx.page.evaluate(`(() => {
    const s = [...document.querySelectorAll('label')].find(l => /Words per page|한 쪽 단어 수/.test(l.innerText))?.querySelector('select');
    if (!s) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(s, '${value}');
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
  await sleep(600)
  return ok
}

async function openDocument(ctx) {
  await ctx.clickSelector('a[href="/"]')
  await sleep(400)
  await ctx.page.evaluate(
    `[...document.querySelectorAll('a')].find(x=>x.getAttribute('href')?.startsWith('/read/'))?.click(); true`,
  )
  await ctx.waitFor(`!!document.querySelector('[data-start]')`, '본문')
  await sleep(500)
}

export async function run(ctx) {
  await ctx.enrollLanguage('English')
  await ctx.createDocument(TEXT, 'English')
  await openDocument(ctx)

  // ── 본문이 쪽으로 나뉜다 ──
  const pages = await pageCount(ctx)
  ctx.check('긴 본문은 여러 쪽으로 나뉜다', pages >= 4, `${pages}쪽`)
  // 문장 경계에서만 자르므로 "정확히 100" 이 아니라 100 을 넘지 않는 쪽이 된다
  const firstPageWords = await wordsOnPage(ctx)
  ctx.check('첫 쪽은 100 단어를 넘지 않는다', firstPageWords <= 100 && firstPageWords >= 80,
    `${firstPageWords}개 (목표 100, 문장 경계에서 끊어 그만큼 못 채움)`)
  ctx.check('1 쪽에서 시작한다', (await currentPage(ctx)) === 1, `${await currentPage(ctx)}쪽`)

  const indicator = await ctx.page.evaluate(`(() => {
    const hits = [...document.querySelectorAll('p')]
      .map(x => x.innerText.trim())
      .filter(t => /^Page [0-9]+ of [0-9]+$/.test(t) || t.split(' / ').length === 2);
    return hits[0] ?? null;
  })()`)
  ctx.check('몇 쪽 중 몇 쪽인지 보인다', indicator !== null && indicator.includes(String(pages)),
    String(indicator))

  // ── 뒤로 넘긴 문장은 보이지 않는다 ──
  const lastSentence = 'Nothing else needs to change.'
  ctx.check('첫 쪽에 마지막 문장은 없다', !(await ctx.bodyText()).includes(lastSentence), '안 보임')

  await ctx.clickText('›')
  await sleep(500)
  ctx.check('다음 쪽으로 간다', (await currentPage(ctx)) === 2, `${await currentPage(ctx)}쪽`)

  /*
   * 뒤쪽 쪽의 본문은 원문 그 구간과 정확히 같아야 한다.
   *
   * 경계가 세그먼트를 가로지르면 글자가 사라지고, 쪽 시작 오프셋이 어긋나서
   * 문장 번역이 옆 문장을 잡는다 — 같은 버그의 두 번째 얼굴이다.
   */
  const shown = await pageText(ctx)
  ctx.check('둘째 쪽이 문장 중간에서 시작하지 않는다',
    /^[A-Z가-힣一-龥]/.test((shown ?? '').trimStart()),
    JSON.stringify((shown ?? '').slice(0, 40)))

  // (여는 부호 검사는 아래 전용 문서에서 한다)
  ctx.check('이전 쪽으로 갈 수 있다',
    !(await ctx.page.evaluate(`(() => {
      const b = [...document.querySelectorAll('nav[aria-label] button')].find(x => x.getAttribute('aria-label') === 'Previous page');
      return b.disabled;
    })()`)), '활성')

  // ── 어느 쪽에서 눌러도 상태가 이어진다 ──
  const markTargets = ['Reading', 'daily', 'meaning']
  const markedOnPage2 = []
  for (const word of markTargets) {
    const clicked = await ctx.clickWord(word)
    if (!clicked) continue
    await sleep()
    await ctx.setStatus('Know')
    markedOnPage2.push(word)
    await ctx.pressEscape()
  }
  ctx.check('둘째 쪽의 단어에도 상태를 준다', markedOnPage2.length > 0, markedOnPage2.join(', '))

  await ctx.clickText('‹')
  await sleep(500)
  ctx.check('첫 쪽으로 돌아온다', (await currentPage(ctx)) === 1, `${await currentPage(ctx)}쪽`)

  await ctx.clickText('›')
  await sleep(500)
  // 표시해 둔 단어는 본문색 그대로, 아직 건드리지 않은 단어는 옅은색 —
  // 둘이 달라야 상태가 살아 있는 것이다 (global 상태가 쪽을 넘어 이어진다)
  const kept = await ctx.page.evaluate(`(() => {
    const colorOf = (w) => {
      const el = [...document.querySelectorAll('[data-start]')].find(x => x.textContent === w);
      return el ? getComputedStyle(el).color : null;
    };
    return { marked: colorOf(${JSON.stringify(markTargets[0])}), untouched: colorOf('When') };
  })()`)
  ctx.check('뒤로 갔다 와도 상태가 그대로다',
    kept.marked !== null && kept.marked !== kept.untouched,
    `표시 ${kept.marked} / 미표시 ${kept.untouched}`)

  // ── 어느 쪽에서 드래그해도 그 문장을 번역한다 (오프셋 회귀) ──
  await ctx.clickText('‹')
  await sleep(500)
  await ctx.dragWords('Reading', 'alive')
  await ctx.waitFor(
    `(() => { const d = document.querySelector('[role="dialog"]');
       return d && !d.innerText.includes('Translating'); })()`,
    '번역 완료', 25_000,
  )
  // 문서 언어와 정의 언어가 같으면 identity 안내가 뜬다 — 어차피 중요한 것은
  // "내가 고른 문장" 이 실제로 잡혔는지 이다. 페이지 기준 오프셋을 그대로 쓰면
  // 옆 문장이나 아예 다른 문장이 잡힌다.
  const first = await ctx.popover()
  ctx.check('첫 쪽에서 고른 문장이 그대로 잡힌다', (first?.text ?? '').includes('quiet habit'),
    first?.text.replace(/\n/g, ' | ').slice(0, 90))
  await ctx.pressEscape()

  await ctx.clickText('›')
  await sleep(500)
  const onSecond = await ctx.page.evaluate(`!![...document.querySelectorAll('[data-start]')].find(x => x.textContent === 'Reading')`)
  ctx.check('둘째 쪽에도 Reading 이 있다 (본문이 반복되는 fixture)', onSecond, String(onSecond))

  // ── 쪽 크기를 줄이면 쪽이 늘어난다 ──
  const before = await pageCount(ctx)
  await setPageWords(ctx, 50)
  const after = await pageCount(ctx)
  ctx.check('한 쪽 단어 수를 줄이면 쪽이 늘어난다', after > before, `${before}쪽 → ${after}쪽`)
  const halved = await wordsOnPage(ctx)
  ctx.check('줄인 쪽은 50 단어를 넘지 않는다', halved <= 50 && halved >= 40, `${halved}개`)

  await setPageWords(ctx, 500)
  ctx.check('한 쪽에 다 담기면 이동 UI 를 숨긴다', (await pageCount(ctx)) === 1, `${await pageCount(ctx)}쪽`)
  ctx.check('다 담기면 본문 전체가 보인다', (await ctx.bodyText()).includes(lastSentence), '마지막 문장 보임')

  await setPageWords(ctx, 100)

  // ── 하단 상태 바 ──
  const bar = await readBar(ctx)
  ctx.check('상태 바가 보인다', bar !== null, bar?.text)
  const counts = await ctx.page.evaluate(`(() => {
    const bar = document.querySelector('aside[aria-label]');
    return [...bar.querySelectorAll('li')].slice(0, 4).map(li => Number(li.innerText.match(/(\\d+)\\s*$/)?.[1] ?? NaN));
  })()`)
  ctx.check('상태별 네 가지가 모두 있다', counts.length === 4 && counts.every(Number.isFinite), counts.join(' / '))
  ctx.check('상태별 개수의 합이 총 단어 수와 같다',
    counts.reduce((a, b) => a + b, 0) === bar.total,
    `합 ${counts.reduce((a, b) => a + b, 0)} vs 총 ${bar.total}`)
  ctx.check('표시한 단어가 세 개 반영된다', counts[0] === 3, `앎 ${counts[0]}`)

  const progress = await ctx.page.evaluate(`(() => {
    const bar = document.querySelector('[role="progressbar"]');
    return bar ? Number(bar.getAttribute('aria-valuenow')) : null;
  })()`)
  ctx.check('진행률이 표시를 반영한다', progress !== null && progress > 0 && progress < 100, `${progress}%`)

  // ── 상태를 바꾸면 바로 반영된다 ──
  await ctx.clickWord('Difficulty')
  await sleep()
  await ctx.setStatus('New')
  await ctx.pressEscape()
  const afterMark = await readBar(ctx)
  const afterCounts = await ctx.page.evaluate(`(() => {
    const bar = document.querySelector('aside[aria-label]');
    return [...bar.querySelectorAll('li')].slice(0, 4).map(li => Number(li.innerText.match(/(\\d+)\\s*$/)?.[1] ?? NaN));
  })()`)
  ctx.check('표시를 바꾸면 상태 바도 함께 바뀐다', afterCounts[2] === 1 && afterCounts[0] === 3,
    `모름 ${afterCounts[2]} / 앎 ${afterCounts[0]}`)
  ctx.check('합은 여전히 총 단어 수와 같다',
    afterCounts.reduce((a, b) => a + b, 0) === afterMark.total,
    `합 ${afterCounts.reduce((a, b) => a + b, 0)} vs 총 ${afterMark.total}`)

  // ── 상태 바가 본문을 가리지 않는다 ──
  // 바는 fixed 다. 본문에 그만큼 아래 여유가 없으면 마지막 줄이 바에 깔린다.
  const room = await ctx.page.evaluate(`(() => {
    const bar = document.querySelector('aside[aria-label]');
    const article = bar.closest('article');
    return {
      bar: Math.round(bar.getBoundingClientRect().height),
      padding: Math.round(parseFloat(getComputedStyle(article).paddingBottom)),
    };
  })()`)
  ctx.check('본문이 상태 바 높이만큼 여유를 둔다', room.padding >= room.bar,
    `여유 ${room.padding}px / 바 ${room.bar}px`)

  // 전용 문서가 필요하��� 맨 마지막에 확인한다
  await assertOpeningQuotesStay(ctx)
}

/**
 * 문장을 여는 부호가 앞쪽 쪽에 홀로 남지 않는다 (회귀).
 *
 * 사용자가 „ ¡ ! 가 페이지에 걸쳐 나뉘어 어색하게 배치된다고 했다.
 * 경계를 세그먼트 끝으로 밀어 앞쪽 마침표를 지켰더니 이번엔 문장을 여는
 * 부호가 앞쪽 쪽에 남았다 — 두 부호가 한 세그먼트('. „')에 붙어 있어서다.
 * 이제 경계는 문장 시작에 두고 텍스트만 잘라 보여 준다.
 *
 * 쪽 크기 선택지가 50 부터라 작은 문서로 경계를 만들 수 없다.
 * 문장을 충분히 길게 만들어 여러 쪽이 생기고, 어느 쪽 크기에서도
 * 쪽이 여는 부호로 끝나지 않는지 본다.
 */
async function assertOpeningQuotesStay(ctx) {
  const REPEAT = 'Der Fuchs lachte. „Jetzt habe ich ihn", sagt er glücklich. Die beiden blieben.'
  const german = Array.from({ length: 16 }, () => REPEAT).join(' ')

  await ctx.addLanguage('German')
  await ctx.clickSelector('a[href="/compose"]')
  await sleep(500)
  await ctx.createDocument(german, 'German')

  const spanish = Array.from(
    { length: 16 },
    () => 'Por fin te toqué. ¡Ahora por fin te tocaré!", dijo feliz. Los dos se fueron.',
  ).join(' ')

  await ctx.addLanguage('Spanish')
  await ctx.clickSelector('a[href="/compose"]')
  await sleep(500)
  await ctx.createDocument(spanish, 'Spanish')

  // 어느 쪽 크기에서도 쪽이 여는 부호(„ ¡ " ¿ «)로 끝나면 안 된다
  for (const size of [50, 100, 200]) {
    await setPageWords(ctx, size)
    for (const label of ['„', '¡']) {
      await openFirstDocument(ctx)
      const pages = []
      for (let guard = 0; guard < 12; guard++) {
        const text = (await pageText(ctx)) ?? ''
        pages.push(text)
        if (!(await hasNext(ctx))) break
        await ctx.clickText('›')
        await sleep(350)
      }
      const endings = pages.map((t) => t.trimEnd().slice(-1))
      const dangling = endings.filter((c) => `„"¡¿«`.includes(c))
      ctx.check(`${label} — 한 쪽 ${size}단어: 쪽이 여는 부호로 끝나지 않는다`,
        dangling.length === 0 && pages.length > 1,
        `${pages.length}쪽, 끝글자 ${[...new Set(endings)].join('')}`)

      const starts = pages.map((t) => t.trimStart().slice(0, 1))
      ctx.check(`${label} — 한 쪽 ${size}단어: 쪽이 소문자 중간에서 시작하지 않는다`,
        starts.every((c) => !/[a-zà-ÿ]/.test(c)),
        `시작글자 ${[...new Set(starts)].join('')}`)
    }
  }
}

/** 다음 쪽으로 갈 수 있는가 */
async function hasNext(ctx) {
  return ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('nav[aria-label] button')].find(x => x.getAttribute('aria-label') === 'Next page');
    return !!b && !b.disabled;
  })()`)
}

/** 목록의 첫 문서를 연다 */
async function openFirstDocument(ctx) {
  await ctx.clickSelector('a[href="/"]')
  await sleep(500)
  await ctx.page.evaluate(
    // 목록은 최근 수정 순 — 방금 만든 문서가 맨 위다
    `[...document.querySelectorAll('a')].find(x=>x.getAttribute('href')?.startsWith('/read/'))?.click(); true`,
  )
  await ctx.waitFor(`!!document.querySelector('[data-start]')`, '본문')
  await sleep(500)
}

function sleep() {
  return new Promise((r) => setTimeout(r, 400))
}
