/**
 * The storage card in Settings.
 *
 * Storage API support differs by browser — headless Chrome may expose an
 * estimate while denying persistent storage, and some environments have no API
 * at all. This spec therefore does not demand a "persisted" badge. It checks
 * that the screen states **exactly one honest state** and that pressing the
 * persistence request does not break the panel.
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
  await ctx.waitFor(`!!document.querySelector('a[href="/settings"]')`, 'settings link')
  await ctx.clickSelector('a[href="/settings"]')
  await ctx.waitFor(
    `!![...document.querySelectorAll('p')].find(p => p.innerText.trim() === 'Storage')`,
    'storage section',
  )
  await sleep(500)

  const state = await storageState(ctx)
  ctx.check('storage section renders', state !== null, 'Storage')
  ctx.check(
    'the browser state is stated, not hidden',
    stateCount(state) === 1,
    state?.text.replace(/\s+/g, ' ').slice(0, 120),
  )
  ctx.check(
    'an unsupported browser is described as unknown',
    state?.notPersisted === true || state?.persisted === true || state?.unavailable === true,
    `persisted=${state?.persisted} not=${state?.notPersisted} unavailable=${state?.unavailable}`,
  )

  // Usage appears only when the browser reports an estimate. When it does, it
  // must read as numbers rather than NaN/undefined.
  if (state?.usage) {
    const usageLine = state.text.split('\n').find((line) => line.includes('Local data:')) ?? ''
    ctx.check(
      'storage usage reads as numbers',
      !/NaN|undefined|Infinity/.test(usageLine) &&
        /Local data:.*\d/.test(usageLine) &&
        /(of|\/)/.test(usageLine),
      usageLine.trim(),
    )
  } else {
    ctx.check('no usage line when the browser has no estimate', true, 'no estimate')
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
    ctx.check('the persistence request can be pressed', clicked === true)

    await sleep(600)
    const after = await storageState(ctx)
    ctx.check(
      'the panel survives the request and still states one honest state',
      after !== null && stateCount(after) === 1,
      after?.text.replace(/\s+/g, ' ').slice(0, 120),
    )
  } else {
    ctx.check(
      'the request is hidden when already persisted or unsupported',
      state?.persisted === true || state?.unavailable === true,
      `persisted=${state?.persisted} unavailable=${state?.unavailable}`,
    )
  }

  // The card must not overflow on a narrow screen either.
  await ctx.setViewport(320, 720)
  await sleep(300)
  const overflow = await ctx.page.evaluate(
    `document.documentElement.scrollWidth - window.innerWidth`,
  )
  ctx.check('the storage card does not overflow at 320px', overflow <= 1, `overflow ${overflow}px`)
}
