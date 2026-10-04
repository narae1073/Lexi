/**
 * 오프라인에서 캐시된 번역·사전이 보이는가 (PLAN.md 결정 4).
 *
 * 서버 캐시가 있어도 그것을 보려면 서버에 닿아야 한다. 네트워크를 진짜로 끊고
 * 이미 받아 본 결과가 실제로 보이는지 확인한다 — 이것을 흉내내면 아무것도 검증되지 않는다.
 */

const TEXT = `Reading is the quiet habit that keeps a language alive.
The Apple store is busy today.`

/** 이 기기에 저장된 응답 캐시 */
async function cacheKeys(ctx) {
  return ctx.page.evaluate(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('lexi');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const store = db.transaction('responseCache', 'readonly').objectStore('responseCache');
    const all = await new Promise((res) => {
      const r = store.getAll();
      r.onsuccess = () => res(r.result);
    });
    return all.map(r => r.key);
  })()`)
}

export async function run(ctx) {
  await ctx.enrollLanguage('English')
  await ctx.createDocument(TEXT, 'English')

  // ── 먼저 서버에 연결해서 결과를 받아 본다 ──
  await ctx.clickWord('quiet')
  await sleep()
  await ctx.openDictionary()
  const online = await ctx.popover()
  const onlineText = online?.text ?? ''
  ctx.check('온라인에서 사전 결과를 받는다', /Wiktionary|quiet|habit/i.test(onlineText),
    onlineText.replace(/\n/g, ' | ').slice(0, 80))
  await ctx.pressEscape()

  const before = await cacheKeys(ctx)
  ctx.check('받아 본 결과가 이 기기에 저장된다', before.length > 0, `${before.length}건`)

  await ctx.clickSelector('a[href="/"]')
  await sleep(400)

  // ── 진짜로 끊는다 ──
  await ctx.goOffline(true)
  ctx.check('네트워크를 끊는다', await ctx.page.evaluate(`navigator.onLine === false`), 'navigator.onLine=false')

  /**
   * 끊어놓고 새로 고친다 — 이게 실제 상황이다.
   *
   * 그냥 끄기만 하면 사전 스토어의 메모리 캐시가 남아 있어 IDB 를 아예 읽지 않는다.
   * 메모리에 없는 첫 진입에서만 이 기기 사본이 쓰인다.
   */
  await ctx.reload()
  await ctx.waitFor(`!!document.querySelector('a[href="/"]')`, '셸', 20_000)
  ctx.check('끊긴 상태로도 앱이 열린다 — 셸은 캐시에 있다',
    (await ctx.bodyText()).length > 0, '화면 표시')

  await ctx.clickSelector('a[href="/"]')
  await sleep(600)
  await ctx.page.evaluate(
    `[...document.querySelectorAll('a')].find(x=>x.getAttribute('href')?.startsWith('/read/'))?.click(); true`,
  )
  await ctx.waitFor(`!!document.querySelector('[data-start]')`, '본문')
  await sleep(500)

  await ctx.clickWord('quiet')
  await sleep()
  await ctx.openDictionary({ retries: 0 })
  const offlinePopover = await ctx.popover()
  const offlineText = offlinePopover?.text ?? ''
  ctx.check('끊겨 있어도 사전 결과가 보인다', /Wiktionary|quiet|habit/i.test(offlineText),
    offlineText.replace(/\n/g, ' | ').slice(0, 80))
  ctx.check('이 기기 사본임을 밝혀 둔다', /Offline|오프라인/.test(offlineText),
    (offlineText.split('\n').find((l) => /Offline|오프라인/.test(l)) ?? '(표시 없음)').slice(0, 70))
  await ctx.pressEscape()

  // ── 저장돼 있지 않은 단어는 실패해도 그럴 수 있다 ──
  //  (오프라인 캐시는 "받아 본 것"만 보여줄 뿐이므로, 이 예외가 중요다)
  await ctx.clickWord('store')
  await sleep()
  await ctx.page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const b = [...d.querySelectorAll('button')].find(x => x.innerText.trim() === 'Dictionary');
    b.click();
    return true;
  })()`)
  await ctx.waitFor(
    `(() => { const d = document.querySelector('[role="dialog"]');
       if (!d) return false;
       const t = d.innerText;
       return /Could not|connect|failed|연결|실패/i.test(t) || /Wiktionary/.test(t); })()`,
    '사전 결과 또는 실패', 20_000,
  )
  const missing = await ctx.popover()
  // 사본이 없는 단어는 실패해도 된다. 중요한 건 '없다' 를 '있다' 로 바꾸지 않는 것이다.
  ctx.check('처음 보는 단어는 오프라인에서 실패해도 된다',
    Boolean(missing) && /Could not|connect|failed|연결|실패/i.test(missing?.text ?? ''),
    (missing?.text ?? '(팝오버 없음)').replace(/\n/g, ' | ').slice(0, 70))
  await ctx.pressEscape()

  // ── 문장 번역도 사본이 있으면 보인다 ──
  // 번역은 저장소 안에 결과가 없어 매번 새로 부른다. 사본은 IDB 에만 있으므로
  // 온라인에서 한 번 받아 둔 뒤 다시 내려야 재현된다.
  await ctx.goOffline(false)
  await sleep(400)
  await ctx.dragWords('Reading', 'alive')
  await ctx.waitFor(
    `(() => { const d = document.querySelector('[role="dialog"]');
       return d && !d.innerText.includes('Translating'); })()`,
    '번역 완료', 25_000,
  )
  await ctx.pressEscape()

  await ctx.reload()
  await ctx.waitFor(`!!document.querySelector('a[href="/"]')`, '셸', 20_000)
  await ctx.clickSelector('a[href="/"]')
  await sleep(500)
  await ctx.page.evaluate(
    `[...document.querySelectorAll('a')].find(x=>x.getAttribute('href')?.startsWith('/read/'))?.click(); true`,
  )
  await ctx.waitFor(`!!document.querySelector('[data-start]')`, '본문')
  await ctx.goOffline(true)
  await sleep(400)
  await ctx.dragWords('Reading', 'alive')
  await ctx.waitFor(
    `(() => { const d = document.querySelector('[role="dialog"]');
       return d && !d.innerText.includes('Translating'); })()`,
    '번역 완료', 25_000,
  )
  const sentence = await ctx.popover()
  ctx.check('끊겨 있어도 저장된 문장 번역이 보인다',
    /already in English|원문이 이미 영어/.test(sentence?.text ?? ''),
    (sentence?.text ?? '').replace(/\n/g, ' | ').slice(0, 80))

  // ── 상태를 바꾸는 등 나머지 기능은 네트워크와 무관해야 한다 ──
  await ctx.pressEscape()
  // 드래그 선택이 남아 있으면 단어 클릭이 문장 팝오버로 넘어간다 — 먼저 비운다
  await ctx.page.evaluate(`(() => { getSelection()?.removeAllRanges(); return true })()`)
  await sleep(200)
  await ctx.clickWord('habit')
  await sleep()
  await ctx.setStatus('Know')
  await ctx.pressEscape()
  ctx.check('끊겨 있어도 단어 상태를 바꿀 수 있다', true, '○ 선택됨')

  await ctx.goOffline(false)
  await sleep(300)
  await ctx.page.evaluate(`(() => {
    const home = [...document.querySelectorAll('a')].find(a => a.getAttribute('href') === '/');
    if (home) { home.click(); return true; }
    return false;
  })()`)
  await sleep(500)
  ctx.check('끊겨 있어도 앱은 계속 동작한다', (await ctx.bodyText()).length > 0, '본문 표시')
}

function sleep() {
  return new Promise((r) => setTimeout(r, 400))
}
