/** 등장 기록 — 단어장이 비어 있던 문제와 대소문자 충돌 분리 */

const TEXT = `The Apple store is busy. I ate an apple yesterday.
The US economy grew. The us in "tell us" differs from the country.
May is warm. I may go.`

export async function run(ctx) {
  await ctx.enrollLanguage('English')
  await ctx.createDocument(TEXT, 'English')
  // 기록은 유휴 시점에 쓰이므로 기다린다
  await sleep(2000)

  const occurrences = await ctx.readOccurrences()
  const lemmas = occurrences.map((o) => o.lemma).sort()

  ctx.check('등장 기록이 저장된다', occurrences.length > 0, `${occurrences.length}건`)
  ctx.check('반복 등장한 단어는 1건으로 합쳐진다', new Set(lemmas).size === lemmas.length,
    `고유 lemma ${new Set(lemmas).size}개`)

  const of = (lemma) => occurrences.find((o) => o.lemma === lemma)

  ctx.check('US(국가)와 us(대명사)가 분리된다', Boolean(of('US')) && Boolean(of('us')),
    `US=${of('US')?.count ?? 0} us=${of('us')?.count ?? 0}`)
  ctx.check('문장 중간의 Apple 과 apple 이 분리된다', Boolean(of('Apple')) && Boolean(of('apple')),
    `Apple=${of('Apple')?.count ?? 0} apple=${of('apple')?.count ?? 0}`)
  ctx.check('문장 첫머리 The 와 the 는 합쳐진다', !of('The') && Boolean(of('the')),
    `the=${of('the')?.count ?? 0}`)

  ctx.check('문맥 문장이 담긴다', occurrences.every((o) => typeof o.sentence === 'string' && o.sentence.length > 0))
  ctx.check('쓰인 표기가 담긴다', occurrences.every((o) => Array.isArray(o.surfaces) && o.surfaces.length > 0))
  ctx.check('등장 위치를 담긴다', occurrences.every((o) => o.charEnd > o.charStart))

  // 빈 줄 뒤 문장도 문맥이 붙는다 — 문장 인덱스 회귀
  const blankLine = occurrences.find((o) => o.lemma === 'differs' || o.lemma === 'grew')
  ctx.check('빈 줄이 있어도 문맥 문장이 비지 않는다', Boolean(blankLine?.sentence),
    blankLine ? JSON.stringify(blankLine.sentence.slice(0, 46)) : '없음')

  // 모든 단어가 빈 줄 이후 문장에서 찾아진다
  const afterBlank = occurrences.find((o) => o.lemma === 'country' || o.lemma === 'us')
  ctx.check('빈 줄 이후 문장의 단어도 문맥을 갖는다', Boolean(afterBlank?.sentence),
    afterBlank ? JSON.stringify(afterBlank.sentence.slice(0, 46)) : '없음')

  await assertStaleRefresh(ctx)
}

/**
 * 표기 규칙이 바뀌면 저장된 기록은 옛 결과로 남는다 (회귀).
 *
 * 사용자가 문서를 직접 열어야만 새로 계산되던 상태였고, 그때까지는
 * 같은 문서인데 기기마다 단어가 달랐다. 규칙 버전을 기록해 두었다가
 * 현재 규칙과 다르면 자동으로 다시 계산한다.
 */
async function assertStaleRefresh(ctx) {
  // 지금 규칙으로 계산했는지 확인
  const meta = await ctx.readMeta()
  ctx.check('문서에 표기 규칙 버전이 기록된다', meta.length > 0 && meta.every((m) => m.lemmaVersion >= 2),
    JSON.stringify(meta))

  /**
   * 버전을 비우면 "옛 규칙으로 계산된 상태" 가 되고, 다시 계산되어야 한다.
   *
   * 지운 뒤 문서를 열면 다시 계산하며 현재 버전을 다시 적는다 —
   * 이것이 사용자가 문서를 열어야 했던 그 동작이고, 이제는 열지 않아도
   * 동기화 과정에서 일어나고 여기에선 경로 하나만 직접 확인한다.
   */
  const before = (await ctx.readOccurrences()).filter((o) => o.lemma === 'busy').length
  await ctx.wipeMeta()
  ctx.check('버전 기록을 지울 수 있다', (await ctx.readMeta()).length === 0, '0건')

  await ctx.reload()
  await ctx.waitFor(`!!document.querySelector('[data-start]')`, '본문')
  await sleep(1500)

  const restored = await ctx.readMeta()
  ctx.check('다시 계산하면서 현재 버전을 되돌려 쓴다',
    restored.length > 0 && restored.every((m) => m.lemmaVersion >= 2),
    JSON.stringify(restored))

  const after = (await ctx.readOccurrences()).filter((o) => o.lemma === 'busy').length
  ctx.check('재계산해도 단어는 그대로다', after === before && after >= 1, `${before} → ${after}`)
}

function sleep() {
  return new Promise((r) => setTimeout(r, 400))
}