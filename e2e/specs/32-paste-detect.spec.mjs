/** 붙여넣은 글의 언어 감지 — 배우는 언어 안에서 버튼이 옮겨 가고, 정정을 존중한다 */

const JA_TEXT = '今日はいい天気ですね。散歩に行きましょう。'
const ES_TEXT = 'La familia es grande y muy feliz hoy con la música.'

export async function run(ctx) {
  await ctx.enrollLanguage('German')
  await ctx.addLanguage('English')

  await ctx.clickSelector('a[href="/compose"]')
  await sleep(500)

  // 처음의 언어 버튼 — 배운 언어 중 첫 것(독일어)이다
  const before = await pressedChip(ctx)
  ctx.check('처음에는 독일어가 눌려 있다', /German/.test(before ?? ''), before ?? '')

  // ── 배우지 않는 언어(스페인어)를 붙여넣는다 — 옮기지 않고 알려 준다 ──
  await paste(ctx, ES_TEXT)
  await sleep(400)

  ctx.check('배우지 않는 언어로는 옮기지 않는다', /German/.test((await pressedChip(ctx)) ?? ''), await pressedChip(ctx))
  const suggest = await noticeOf(ctx)
  ctx.check(
    '어떤 언어로 보이는지 말해 준다',
    /Spanish/.test(suggest ?? '') && /Languages/.test(suggest ?? ''),
    suggest ?? '',
  )

  // ── 언어에 추가한 뒤에는 옮겨 간다 (실제 paste 이벤트로) ──
  await ctx.addLanguage('Japanese')
  await ctx.clickSelector('a[href="/compose"]')
  await sleep(500)
  await clickLanguageChip(ctx, 'German') // 스펙 순서를 고정하기 위해 독일어를 직접 누른다 — 직접 고른 것도 정정이다

  await paste(ctx, JA_TEXT)
  await sleep(400)

  const after = (await pressedChip(ctx)) ?? ''
  ctx.check('언어 버튼이 일본어로 옮겨 간다', /Japanese/.test(after), after)

  const notice = await noticeOf(ctx)
  ctx.check('바꾼 것을 밝힌다', /Switched to/.test(notice ?? ''), notice ?? '')

  // ── 되돌리기 — 정정한 뒤에는 다시 옮기지 않는다 ──
  await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('p[role="status"] button')].find(x => x.innerText === 'Undo');
    if (b) b.click();
    return true;
  })()`)
  await sleep(300)

  const reverted = (await pressedChip(ctx)) ?? ''
  ctx.check('되돌리기가 독일어로 돌려 놓는다', /German/.test(reverted), reverted)
  ctx.check('알림이 사라진다', (await noticeOf(ctx)) === null, '')

  // 정정 뒤의 붙여넣기는 언어 버튼을 다시 옮기지 않는다
  await paste(ctx, ES_TEXT)
  await sleep(300)
  const suppressed = (await pressedChip(ctx)) ?? ''
  ctx.check('정정 뒤에는 다시 옮기지 않는다', /German/.test(suppressed), suppressed)

  // ── 직접 고른 것도 정정이다 ──
  await clickLanguageChip(ctx, 'English')
  await sleep(200)
  await paste(ctx, JA_TEXT)
  await sleep(300)
  const manual = (await pressedChip(ctx)) ?? ''
  ctx.check('직접 고른 언어는 붙여넣기가 건드리지 않는다', /English/.test(manual), manual)
}

/** 눌려 있는 언어 버튼의 이름 */
async function pressedChip(ctx) {
  return ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button[aria-pressed="true"]')].find(x =>
      ['English', 'German', 'Japanese', 'Spanish', 'French', 'Portuguese', 'Korean', 'Chinese (Simplified)']
        .some(n => x.innerText.includes(n)));
    return b ? b.innerText : null;
  })()`)
}

/** 자동 감지 알림 — p[role=status] 이다 */
async function noticeOf(ctx) {
  return ctx.page.evaluate(`(() => {
    const p = document.querySelector('p[role="status"]');
    return p ? p.innerText : null;
  })()`)
}

/** 작성 화면의 언어 칩 — 국기가 붙으므로 포함 매칭으로 누른다 */
async function clickLanguageChip(ctx, label) {
  const ok = await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.innerText.includes(${JSON.stringify(label)}));
    if (!b) return false;
    b.click();
    return true;
  })()`)
  if (!ok) throw new Error(`언어 칩을 찾지 못함: ${label}`)
  await sleep(200)
}

/** 실제 paste 이벤트를 태운다 — insertText 는 paste 이벤트를 내지 않으므로 */
async function paste(ctx, text) {
  await ctx.page.evaluate(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) throw new Error('textarea 없음');
    const dt = new DataTransfer();
    dt.setData('text/plain', ${JSON.stringify(text)});
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  })()`)
}

function sleep(ms = 400) {
  return new Promise((r) => setTimeout(r, ms))
}
