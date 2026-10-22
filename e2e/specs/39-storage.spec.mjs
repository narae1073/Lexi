/**
 * 설정의 저장 공간 카드.
 *
 * 브라우저마다 Storage API 지원이 다르다 — 헤드리스 크롬은 estimate 는 주면서도
 * persistent 저장을 거절할 수 있고, 일부 환경은 API 자체가 없다. 그래서 이 스펙은
 * '보관됨' 을 강요하지 않는다. 대신 화면이 **셋 중 하나를 정직하게** 말하는지,
 * 보관 요청 버튼을 눌러도 화면이 깨지지 않는지를 확인한다.
 */

function sleep(ms = 300) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function storageState(ctx) {
  return ctx.page.evaluate(`(() => {
    const title = [...document.querySelectorAll('p')].find(p => p.innerText.trim() === 'Storage');
    const panel = title?.parentElement;
    if (!panel) return null;
    const text = panel.innerText;
    return {
      persisted: /keeps local data even when space runs low/.test(text),
      notPersisted: /may clear local data when space runs low/.test(text),
      unavailable: /does not report storage status/.test(text),
      usage: /Local data:/.test(text),
      request: [...panel.querySelectorAll('button')].some(
        (b) => b.innerText.trim() === 'Ask the browser to keep data',
      ),
      text,
    };
  })()`)
}

function stateCount(state) {
  return [state?.persisted, state?.notPersisted, state?.unavailable].filter(Boolean).length
}

export async function run(ctx) {
  // Settings is behind onboarding on a fresh origin.
  await ctx.enrollLanguage('English')
  await ctx.waitFor(`!!document.querySelector('a[href="/settings"]')`, '설정 링크')
  await ctx.clickSelector('a[href="/settings"]')
  await ctx.waitFor(
    `!![...document.querySelectorAll('p')].find(p => p.innerText.trim() === 'Storage')`,
    '저장 공간 영역',
  )
  await sleep(500)

  const state = await storageState(ctx)
  ctx.check('저장 공간 영역이 보인다', state !== null, 'Storage')
  ctx.check(
    '브라우저 상태를 숨기지 않고 말한다',
    stateCount(state) === 1,
    state?.text.replace(/\s+/g, ' ').slice(0, 120),
  )
  ctx.check(
    '지원하지 않으면 모른다고 말한다',
    state?.notPersisted === true || state?.persisted === true || state?.unavailable === true,
    `persisted=${state?.persisted} not=${state?.notPersisted} unavailable=${state?.unavailable}`,
  )

  // 용량 표시는 브라우저가 알려줄 때만 나온다. 나오면 숫자가 깨지지 않았는지 본다.
  if (state?.usage) {
    const usageLine = state.text.split('\n').find((line) => line.includes('Local data:')) ?? ''
    ctx.check(
      '저장 용량 표시가 숫자로 읽힌다',
      !/NaN|undefined|Infinity/.test(usageLine) &&
        /Local data:.*\d/.test(usageLine) &&
        /(of|\/)/.test(usageLine),
      usageLine.trim(),
    )
  } else {
    ctx.check('용량을 모르면 표시하지 않는다', true, 'no estimate')
  }

  if (state?.request) {
    // The request must be a valid user gesture and must not throw. The result
    // may still be a denial; the copy must stay one honest state.
    const clicked = await ctx.page.evaluate(`(() => {
      const title = [...document.querySelectorAll('p')].find(p => p.innerText.trim() === 'Storage');
      const panel = title?.parentElement;
      const button = panel && [...panel.querySelectorAll('button')].find(
        (b) => b.innerText.trim() === 'Ask the browser to keep data',
      );
      if (!button) return false;
      button.click();
      return true;
    })()`)
    ctx.check('보관 요청 버튼을 누를 수 있다', clicked === true)

    await sleep(600)
    const after = await storageState(ctx)
    ctx.check(
      '요청 뒤에도 화면이 깨지지 않고 상태를 하나만 말한다',
      after !== null && stateCount(after) === 1,
      after?.text.replace(/\s+/g, ' ').slice(0, 120),
    )
  } else {
    ctx.check(
      '이미 보관 중이거나 지원하지 않으면 요청 버튼을 숨긴다',
      state?.persisted === true || state?.unavailable === true,
      `persisted=${state?.persisted} unavailable=${state?.unavailable}`,
    )
  }

  // 좁은 화면에서도 카드가 넘치지 않는다.
  await ctx.setViewport(320, 720)
  await sleep(300)
  const overflow = await ctx.page.evaluate(
    `document.documentElement.scrollWidth - window.innerWidth`,
  )
  ctx.check('320px 에서도 저장 공간 카드가 넘치지 않는다', overflow <= 1, `넘침 ${overflow}px`)
}
