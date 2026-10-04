/**
 * 메인 화면이 다시 그려지지 않는지 지켜본다.
 *
 * 회귀: 동기화가 끝날 때마다 문서를 다시 읽으면서 '불러오는 중' 으로 비웠다.
 * 화면은 이미 문서를 보여 주고 있는데 없는 것처럼 보이는 셈이고, 동기화가 자주
 * 돌아니 읽는 내내 깜빡였다.
 *
 * 여기서는 목록이 DOM 에서 사라지지 않는지 본다 — '불러오는 중' 으로 바뀌는 순간
 * 목록은 지워졌다가 다시 생긴다.
 */

const TEXT = `The policy is written in a document.
Every policy needs a careful review.
The committee revised the policy.
A policy that nobody reads is useless.`

export async function run(ctx) {
  await ctx.enrollLanguage('English')
  await ctx.createDocument(TEXT, 'English')
  await sleep(2000)

  await ctx.clickSelector('a[href="/"]')
  await sleep(800)
  ctx.check('목록이 보인다', (await ctx.page.evaluate(`!!document.querySelector('li')`)), '목록')

  /**
   * 목록이 DOM 에서 없어진 횟수를 센다.
   *
   * MutationObserver 로 'li' 가 사라지는 순간을 센다. 목록이 통째로 갈아끼워지는
   * 순간에 li 들이 제거되고 다시 추가된다 — 사람이 보기에는 화면이 깜빡인 셈이다.
   */
  await ctx.page.evaluate(`(() => {
    window.__removed = 0;
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.removedNodes) {
          if (node.nodeType === 1 && (node.matches('li') || node.querySelector?.('li'))) {
            window.__removed++;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.__observer = observer;
    return true;
  })()`)

  // 단어를 여러 번 표시한다 — 저장이 쌓이고 동기화가 반복된다
  for (let i = 0; i < 6; i++) {
    await ctx.page.evaluate(`(() => {
      const el = [...document.querySelectorAll('[data-start]')].find(e => e.textContent === 'policy');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight) return false;
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + 2, clientY: r.top + 2 }));
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r.left + 2, clientY: r.top + 2 }));
      return true;
    })()`)
    await sleep(700)
    await ctx.page.evaluate(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true;
    })()`)
    await sleep(200)
  }

  // 입력이 끝난 뒤에도 시간이 지나야 깜빡임이 드러난다 — 동기화가 1.2초 뒤에 돈다
  await sleep(4000)

  const flickers = await ctx.page.evaluate(`(() => {
    window.__observer?.disconnect();
    return { removed: window.__removed, hasList: !!document.querySelector('li') };
  })()`)
  ctx.check('목록이 DOM 에서 사라지지 않는다', flickers.removed === 0, JSON.stringify(flickers))
  ctx.check('끝나도 목록이 남아 있다', flickers.hasList === true, JSON.stringify(flickers))

  const stillLoading = await ctx.page.evaluate(`(() => {
    const text = document.body.innerText;
    return /불러오는 중|Loading/.test(text);
  })()`)
  ctx.check("다 읽은 뒤에 '불러오는 중' 이 남지 않는다", stillLoading === false, String(stillLoading))

  // 휴대전화에서도 같다
  await ctx.setViewport(390, 740)
  await sleep(600)
  await ctx.page.evaluate(`(() => {
    window.__removed = 0;
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.removedNodes) {
          if (node.nodeType === 1 && (node.matches('li') || node.querySelector?.('li'))) window.__removed++;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.__observer = observer;
    return true;
  })()`)
  await sleep(4000)
  const mobile = await ctx.page.evaluate(`(() => {
    window.__observer?.disconnect();
    return window.__removed;
  })()`)
  ctx.check('휴대전화에서도 목록이 사라지지 않는다', mobile === 0, `제거 ${mobile}번`)
}

function sleep(ms = 400) {
  return new Promise((r) => setTimeout(r, ms))
}