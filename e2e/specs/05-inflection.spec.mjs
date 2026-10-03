/**
 * 활용형 → 기본형 매핑의 언어별 처리.
 *
 * 이 스펙이 회귀를 막는 이유: 활용형이 기본형 없이 단독으로 뜨면 조용히 실패한다.
 * 숫자만 봐서는 "사전이 아예 없음"과 구분되지 않기 때문이다.
 */

const CASES = [
  {
    language: 'German',
    text: 'Er lebte lange in Hamburg. Die Häuser waren alt.',
    expect: [
      ['lebte', 'leben', '규칙 활용 — 표기 + 기본형 2개 섹션'],
      ['Häuser', 'Haus', '복수 → 기본형'],
      ['waren', 'sein', 'be 동사 → sein'],
      ['Hamburg', 'Hamburg', '고유명사는 표기 그대로'],
    ],
  },
  {
    language: 'Spanish',
    text: 'Miraba el reloj. Comía todos los días.',
    expect: [
      ['Miraba', 'mirar', '문장 첫머리 대문자 → 기본형'],
      ['Comía', 'comer', '활용 → 기본형'],
    ],
  },
  {
    language: 'French',
    text: "Ils chantaient dans la maison.",
    expect: [['chantaient', 'chanter', '불완과거 → 기본형']],
  },
]

export async function run(ctx) {
  let onboarded = false

  for (const testCase of CASES) {
    if (!onboarded) {
      await ctx.enrollLanguage(testCase.language)
      onboarded = true
    } else {
      await ctx.addLanguage(testCase.language)
      await ctx.clickSelector('a[href="/compose"]')
      await sleep()
    }
    await ctx.createDocument(testCase.text, testCase.language)

    for (const [surface, baseForm, label] of testCase.expect) {
      const clicked = await ctx.clickWord(surface)
      if (!clicked) {
        ctx.check(`${testCase.language} "${surface}" (${label})`, false, '단어를 찾지 못함')
        continue
      }
      await sleep()
      const popover = await ctx.openDictionary()
      ctx.check(
        `${testCase.language} "${surface}" → ${baseForm} (${label})`,
        Boolean(popover?.forms.includes(baseForm)),
        `섹션 ${popover?.sections} [${(popover?.forms ?? []).join(', ')}]`,
      )
      await ctx.pressEscape()
    }

    // 홈으로 돌아가 다음 언어를 추가한다
    await ctx.clickSelector('a[href="/"]')
    await sleep(400)
  }
}

function sleep() {
  return new Promise((r) => setTimeout(r, 500))
}