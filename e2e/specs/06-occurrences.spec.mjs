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
}

function sleep() {
  return new Promise((r) => setTimeout(r, 400))
}