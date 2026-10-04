/** 온보딩 → 텍스트 입력 → 문서 열람 (plan.txt 2줄) */

export async function run(ctx) {
  await ctx.enrollLanguage('Korean')
  ctx.check('언어 선택 후 메인 화면으로 넘어간다', (await ctx.bodyText()).includes('Paste a text'))

  /**
   * 버튼을 조용히 끄지 않는다.
   *
   * 예전엔 20자 미만이면 버튼이 꺼졌다. 30% 투명도의 꺼진 버튼은 휴대전화에서
   * 손대지 않은 화면처럼 보여서 "안 먹는다" 고 오해하기 쉬웠고, 짧은 문장 하나가
   * 학습 대상으로 흔한데도 막혔다. 이제는 언제나 눌리고, 비었을 때 이유를 말한다.
   */
  await ctx.typeIntoTextarea('짧음')
  await sleep()
  const notDisabled = await ctx.page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button[type="submit"]')][0];
    return b ? !b.disabled : null;
  })()`)
  ctx.check('버튼이 꺼지지 않는다', notDisabled === true, String(notDisabled))

  await ctx.page.evaluate(`(() => {
    const t = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(t, '');
    t.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await sleep(300)
  await ctx.page.evaluate(`document.querySelector('button[type="submit"]').click(); true`)
  await sleep(400)
  const emptyReason = await ctx.page.evaluate(`(() => {
    const el = document.querySelector('[role="alert"]');
    return el ? el.innerText.trim() : null;
  })()`)
  ctx.check('빈 본문이면 이유를 말한다', Boolean(emptyReason && emptyReason.length > 5), String(emptyReason))
  ctx.check('빈 상태로 넘어가지 않는다', (await ctx.bodyText()).includes('Create document'),
    (await ctx.bodyText()).split('\n').slice(0, 3).join(' | '))

  const TEXT = `나는 매일 글을 읽습니다.
Ubiquitous smartphones changed communication everywhere.`
  await ctx.typeIntoTextarea(TEXT)
  await ctx.clickText('Create document')
  await sleep()
  await ctx.clickSelector('a[href="/"]')
  await sleep()
  await ctx.waitFor(
    `!![...document.querySelectorAll('a')].find(x=>x.getAttribute('href')?.startsWith('/read/'))`,
    '문서 목록',
  )
  ctx.check('문서가 목록에 추가된다', (await ctx.bodyText()).includes('Untitled'))  // 기본 제목은 i18n 에서 온다

  // ── 목록 오른쪽 진도 게이지 (plan.txt 8줄 과 같은 기준) ──
  await ctx.clickSelector('a[href="/"]')
  await sleep(600)
  const gauge = await ctx.page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('li')];
    return rows.map(li => {
      const bar = li.querySelector('[role="progressbar"]');
      const note = li.textContent.match(/(\\d+)% marked/);
      return {
        percent: bar ? Number(bar.getAttribute('aria-valuenow')) : null,
        width: bar ? bar.firstElementChild?.style.width : null,
        note: note ? Number(note[1]) : null,
      };
    });
  })()`)
  ctx.check('목록에 진도 게이지가 보인다',
    gauge.length > 0 && gauge.every((g) => g.percent === 0 && g.width === '0%'),
    JSON.stringify(gauge.slice(0, 2)))

  // 문장을 열면 기록이 쌓이고, 표시한 단어가 생기면 비율이 오른다
  await ctx.page.evaluate(`[...document.querySelectorAll('a')].find(x=>x.getAttribute('href')?.startsWith('/read/'))?.click(); true`)
  await ctx.waitFor(`!!document.querySelector('[data-start]')`, '본문')
  await sleep(1200)
  // 이 문서는 한국어다 — 표기가 다른 단어를 고르면 토크나이저가 통째로 다른 것으로 본다
  for (const word of ['나는', '매일', '글을']) {
    if (await ctx.clickWord(word)) {
      await sleep()
      await ctx.setStatus('Know')
      await ctx.pressEscape()
    }
  }
  await ctx.clickSelector('a[href="/"]')
  await sleep(600)
  const afterMark = await ctx.page.evaluate(`(() => {
    const li = [...document.querySelectorAll('li')].find(x => x.textContent.includes('Untitled'));
    const bar = li?.querySelector('[role="progressbar"]');
    const note = li?.textContent.match(/(\\d+)% marked/);
    return { percent: bar ? Number(bar.getAttribute('aria-valuenow')) : null, note: note ? Number(note[1]) : null };
  })()`)
  ctx.check('표시한 단어가 반영되어 비율이 오른다',
    afterMark.percent !== null && afterMark.percent > 0 && afterMark.percent === afterMark.note,
    `${afterMark.percent}% (본문 표기 ${afterMark.note}%)`)

  await ctx.page.evaluate(
    `[...document.querySelectorAll('a')].find(x=>x.getAttribute('href')?.startsWith('/read/')).click(); true`,
  )
  await ctx.waitFor(`!!document.querySelector('[data-start]')`, '본문')
  await sleep()

  const header = await ctx.bodyText()
  const stats = header.match(/Korean · (\d+) words · (\d+) sentences/)
  ctx.check('단어·문장 통계가 나온다', Boolean(stats), stats ? `단어 ${stats[1]} · 문장 ${stats[2]}` : '통계 없음')
  // 한국어 4(나는/매일/글을/읽습니다) + 영어 5 = 9 단어, 2문장
  ctx.check('단어 수가 정확하다', stats?.[1] === '9', `예상 9, 실제 ${stats?.[1]}`)
  ctx.check('문장 수가 정확하다', stats?.[2] === '2', `예상 2, 실제 ${stats?.[2]}`)

  // 렌더링이 원문을 그대로 보존해야 한다 — 토크나이저가 글자를 잃으면 조용히 깨진다
  const rebuilt = await ctx.page.evaluate(
    `document.querySelector('article > div')?.textContent ?? null`,
  )
  ctx.check('렌더링 결과가 원문과 일치한다', rebuilt === TEXT, rebuilt === TEXT ? '' : `길이 ${rebuilt?.length} vs ${TEXT.length}`)

  // 새 탭으로 열어도 같은 문서가 보여야 한다 (IndexedDB 영속)
  await ctx.goto()
  await sleep(600)
  ctx.check('새로고침 후에도 문서가 남아 있다', (await ctx.bodyText()).includes('Untitled'))

  // 등장 기록이 쌓인다
  await ctx.page.evaluate(
    `[...document.querySelectorAll('a')].find(x=>x.getAttribute('href')?.startsWith('/read/'))?.click(); true`,
  )
  await ctx.waitFor(`!!document.querySelector('[data-start]')`, '본문 재오픈')
  await sleep(2000)
  const occurrences = await ctx.readOccurrences()
  ctx.check('등장 기록이 저장된다', occurrences.length > 0, `${occurrences.length}건`)

  /**
   * 문서 URL 로 바로 들어가도 문서가 떠야 한다 (회귀).
   *
   * 예전에는 저장소가 아직 비어 있는 첫 렌더에서 "그런 문서 없다" 고 판단해
   * 홈으로 튕겼다. 적재는 effect 에서 시작되므로 적재 전 판단이 언제나 일어났다.
   * 새로고침하거나 링크를 붙여 여는 경우가 전부 여기 걸린다.
   */
  // 지금은 본문 화면이다 — 목록으로 돌아가서 링크를 찾는다
  await ctx.clickSelector('a[href="/"]')
  await sleep(500)
  const docId = await ctx.page.evaluate(`(() => {
    const a = [...document.querySelectorAll('a')].find(x => x.getAttribute('href')?.startsWith('/read/'));
    return a ? a.getAttribute('href').split('/').pop() : null;
  })()`)
  ctx.check('문서 링크를 찾는다', Boolean(docId), String(docId))

  await ctx.navigateTo(`/read/${docId}`)
  await ctx.waitFor(`!!document.querySelector('[data-start]')`, '본문', 15_000)
  ctx.check('문서 URL 로 바로 들어가면 문서가 뜬다',
    !(await ctx.bodyText()).includes('Paste a text'),
    (await ctx.bodyText()).split('\n').slice(0, 3).join(' | '))

  await ctx.navigateTo('/read/없는-문서')
  await sleep(700)
  ctx.check('실제로 없는 문서만 홈으로 보낸다',
    (await ctx.bodyText()).includes('Paste a text') || (await ctx.bodyText()).includes('Add text'),
    (await ctx.bodyText()).split('\n').slice(0, 3).join(' | '))
}

function sleep() {
  return new Promise((r) => setTimeout(r, 400))
}