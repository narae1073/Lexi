/**
 * Quiz Session Complete: the whole word card opens the existing dictionary
 * popover. The card is a native button so it also works with Enter/Space.
 */

const TEXT = 'Running daily is healthy. Studies show better results.'
const WORDS = ['Running', 'Studies', 'healthy']
const THEMES = ['white', 'sepia', 'matcha', 'latte', 'black', 'monaspace', 'dracula', 'monokai', 'tokyo-night', 'nord']

function sleep(ms = 250) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function run(ctx) {
  await ctx.enrollLanguage('English')
  await ctx.createDocument(TEXT, 'English')

  for (const word of WORDS) {
    await ctx.clickWord(word)
    await sleep()
    await ctx.setStatus('New')
    await ctx.pressEscape()
  }

  await ctx.clickText('Quiz')
  await sleep(600)
  await ctx.waitFor(`!!document.querySelector('[data-quiz-language="en"]')`, 'quiz setup')
  await ctx.page.evaluate(`(() => {
    document.querySelector('[data-quiz-language="en"]').click();
    document.querySelector('[data-quiz-size="3"]')?.click();
    return true;
  })()`)
  await sleep(200)
  await ctx.page.evaluate(`document.querySelector('[data-quiz-start]').click(); true`)

  const answered = []
  for (let index = 0; index < WORDS.length; index += 1) {
    await ctx.waitFor(`!!document.querySelector('[data-quiz-word]')`, `quiz word ${index + 1}`)
    answered.push(
      await ctx.page.evaluate(`document.querySelector('[data-quiz-word]')?.innerText ?? ''`),
    )
    await ctx.page.evaluate(`(() => {
      document.querySelector('[data-quiz-answer="unknown"]').click();
      return true;
    })()`)
    await sleep(200)
    await ctx.page.evaluate(`document.querySelector('[data-quiz-next]')?.click(); true`)
    await sleep(250)
  }

  await ctx.waitFor(`!!document.querySelector('[data-quiz-summary]')`, 'quiz summary')

  const cards = await ctx.page.evaluate(`(() => {
    return [...document.querySelectorAll('[data-quiz-change]')].map((row) => {
      const button = row.querySelector('[data-quiz-change-button]');
      const icon = button?.querySelector('[data-quiz-dictionary-icon]');
      const rowRect = row.getBoundingClientRect();
      const buttonRect = button?.getBoundingClientRect();
      return {
        tag: button?.tagName ?? null,
        label: button?.getAttribute('aria-label') ?? null,
        popup: button?.getAttribute('aria-haspopup') ?? null,
        tabIndex: button?.tabIndex ?? null,
        icon: Boolean(icon),
        iconColor: icon ? getComputedStyle(icon).color : null,
        nestedButton: Boolean(button?.querySelector('button')),
        coversCard:
          Boolean(buttonRect) &&
          Math.abs(buttonRect.width - rowRect.width) < 1 &&
          Math.abs(buttonRect.height - rowRect.height) < 1,
      };
    });
  })()`)
  ctx.check(
    '완료 화면의 각 단어 카드는 키보드 단추다',
    cards.length === 3 &&
      cards.every((card) => card.tag === 'BUTTON' && card.tabIndex === 0),
    JSON.stringify(cards),
  )
  ctx.check(
    '카드 전체가 탭 영역이고 사전 아이콘·접근성 이름이 있다',
    cards.every(
      (card) =>
        card.coversCard &&
        card.icon &&
        card.popup === 'dialog' &&
        /Open dictionary for/i.test(card.label ?? '') &&
        card.iconColor !== 'rgba(0, 0, 0, 0)' &&
        !card.nestedButton,
    ),
    JSON.stringify(cards),
  )

  const clickCardPadding = async (index) => {
    const point = await ctx.page.evaluate(`(() => {
      const row = document.querySelectorAll('[data-quiz-change]')[${index}];
      const rect = row.getBoundingClientRect();
      return { x: rect.left + 4, y: rect.top + rect.height / 2 };
    })()`)
    await ctx.page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
    })
    await ctx.page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
    })
  }

  const closeDictionary = async () => {
    await ctx.pressEscape()
    await ctx.waitFor(
      `!document.querySelector('[role="dialog"]')`,
      'summary dictionary closed',
      5_000,
    )
  }

  await clickCardPadding(0)
  await ctx.waitFor(
    `(() => { const d = document.querySelector('[role="dialog"]'); return !!d && !/Looking up/i.test(d.innerText) })()`,
    'summary dictionary from padding',
    15_000,
  )
  const firstDictionary = await ctx.page.evaluate(
    `document.querySelector('[role="dialog"] [data-quiz-summary-dictionary]')?.getAttribute('data-quiz-summary-dictionary') ?? null`,
  )
  ctx.check(
    '카드의 빈 패딩을 눌러도 그 단어의 사전이 열린다',
    firstDictionary === answered[0],
    `${answered[0]} requested, got ${JSON.stringify(firstDictionary)}`,
  )

  const themes = await ctx.page.evaluate(`(() => {
    const themes = ${JSON.stringify(THEMES)};
    const icon = document.querySelector('[data-quiz-dictionary-icon]');
    const dialog = document.querySelector('[role="dialog"]');
    return themes.map((theme) => {
      document.documentElement.dataset.theme = theme;
      const iconStyle = getComputedStyle(icon);
      const dialogStyle = getComputedStyle(dialog);
      return {
        theme,
        iconColor: iconStyle.color,
        dialogBackground: dialogStyle.backgroundColor,
        dialogVisible: dialogStyle.visibility,
      };
    });
  })()`)
  ctx.check(
    '모든 테마에서 사전 아이콘과 팝오버가 보인다',
    themes.every(
      (theme) =>
        theme.iconColor !== 'rgba(0, 0, 0, 0)' &&
        theme.dialogBackground !== 'rgba(0, 0, 0, 0)' &&
        theme.dialogVisible === 'visible',
    ),
    JSON.stringify(themes),
  )
  await ctx.page.evaluate(`document.documentElement.dataset.theme = 'white'; true`)
  await closeDictionary()

  await ctx.page.evaluate(`(() => {
    document.querySelectorAll('[data-quiz-change]')[1].querySelector('span').click();
    return true;
  })()`)
  await ctx.waitFor(
    `(() => { const d = document.querySelector('[role="dialog"]'); return !!d && !/Looking up/i.test(d.innerText) })()`,
    'summary dictionary from word text',
    15_000,
  )
  const secondDictionary = await ctx.page.evaluate(
    `document.querySelector('[role="dialog"] [data-quiz-summary-dictionary]')?.getAttribute('data-quiz-summary-dictionary') ?? null`,
  )
  ctx.check(
    '단어 글자를 눌러도 그 단어의 사전이 열린다',
    secondDictionary === answered[1],
    `${answered[1]} requested, got ${JSON.stringify(secondDictionary)}`,
  )
  await closeDictionary()

  const focused = await ctx.page.evaluate(`(() => {
    const button = document.querySelectorAll('[data-quiz-change-button]')[2];
    button.focus();
    return document.activeElement === button;
  })()`)
  await ctx.page.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: ' ', code: 'Space', text: ' ', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
  })
  await ctx.page.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
  })
  await ctx.waitFor(`!!document.querySelector('[role="dialog"]')`, 'keyboard summary dictionary', 10_000)
  const keyboardDictionary = await ctx.page.evaluate(
    `document.querySelector('[role="dialog"] [data-quiz-summary-dictionary]')?.getAttribute('data-quiz-summary-dictionary') ?? null`,
  )
  ctx.check(
    '키보드로 카드 단추를 활성화할 수 있다',
    focused && keyboardDictionary === answered[2],
    `${answered[2]} requested via keyboard, got ${JSON.stringify(keyboardDictionary)}`,
  )
  await closeDictionary()

  await ctx.setViewport(360, 740)
  await clickCardPadding(0)
  await ctx.waitFor(`!!document.querySelector('[role="dialog"]')`, 'mobile summary dictionary', 10_000)
  const mobile = await ctx.page.evaluate(`(() => {
    const card = document.querySelectorAll('[data-quiz-change]')[0].getBoundingClientRect();
    const box = document.querySelector('[role="dialog"]').getBoundingClientRect();
    return {
      card: { top: card.top, bottom: card.bottom, left: card.left, right: card.right },
      box: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
      viewport: { width: innerWidth, height: innerHeight },
    };
  })()`)
  ctx.check(
    '360px 화면에서도 카드와 사전 팝오버가 화면 안에 있다',
    mobile.card.left >= 0 &&
      mobile.card.right <= mobile.viewport.width &&
      mobile.box.left >= 0 &&
      mobile.box.right <= mobile.viewport.width &&
      mobile.box.top >= 0 &&
      mobile.box.bottom <= mobile.viewport.height,
    JSON.stringify(mobile),
  )
  await closeDictionary()
  await ctx.setViewport(420, 900)
}
