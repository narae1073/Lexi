import type { Dictionary } from './en'

/** en 과 동일한 모양이어야 한다 — 누락·오타는 컴파일 에러가 된다 */
export const ko: Dictionary = {
  appName: 'Lexi',

  nav: {
    languages: '언어',
    compose: '붙여넣기',
    settings: '설정',
  },

  onboarding: {
    title: '배울 언어 선택',
    hint: '공부하고 있는 언어를 고르세요. 나중에 추가할 수 있습니다.',
    selectAtLeastOne: '언어를 1개 이상 고르세요',
    done: '선택 완료',
  },

  compose: {
    title: '텍스트 붙여넣기',
    language: '배울 언어',
    titleField: '제목 (선택)',
    titlePlaceholder: '제목 없음',
    body: '본문',
    bodyPlaceholder: '학습할 언어로 된 글을 붙여넣으세요.',
    counter: '{count}자 · {language}',
    tooShort: '{min}자 이상 입력하세요 (현재 {count}자).',
    create: '문서 만들기',
    pickLanguageFirst: '먼저 배울 언어를 선택하세요.',
  },

  list: {
    loading: '불러오는 중…',
    empty: '아직 문서가 없습니다.',
    meta: '{language} · {count}자 · {date}',
  },

  reader: {
    stats: '단어 {words}개 · 문장 {sentences}개',
    sentenceToggle: '문장 번역',
  },

  status: {
    group: '단어 상태',
    known: '아는 단어',
    unsure: '잘 모르는 단어',
    unknown: '모르는 단어',
    shortKnown: '앎',
    shortUnsure: '헷갈림',
    shortUnknown: '모름',
  },

  dictionary: {
    button: '사전',
    loading: '찾는 중…',
    notFound: '‘{word}’ 항목을 찾지 못했습니다.',
    failed: '사전에 연결하지 못했습니다.',
    failedStatus: '사전 오류 ({status}).',
    source: '위키낱말 · {license}',
    hide: '접기',
    foundAs: '{form} 항목으로 찾음',
    inflectedForm: '활용형',
    baseForm: '기본형',
    sensesCount: '뜻 {count}개',
  },

  sentence: {
    original: '원문',
    translating: '번역 중…',
    retry: '다시 시도',
    identity: '원문이 이미 영어라 번역할 것이 없습니다.',
    failed: '번역에 실패했습니다. 다시 시도해 주세요.',
    failedStatus: '번역 서비스 오류 ({status}).',
    bulkMark: '이 문장의 단어 일괄 표시',
  },

  settings: {
    title: '설정',
    appLanguage: '앱 언어',
    theme: '테마',
    system: '시스템 설정',
    close: '닫기',
  },

  languageNames: {
    en: '영어',
    ja: '일본어',
    ko: '한국어',
    es: '스페인어',
    fr: '프랑스어',
    de: '독일어',
    pt: '포르투갈어',
    zh: '중국어(간체)',
  },
}