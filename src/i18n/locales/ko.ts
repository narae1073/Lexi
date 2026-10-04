import type { Dictionary } from './en'

/** en 과 동일한 모양이어야 한다 — 누락·오타는 컴파일 에러가 된다 */
export const ko: Dictionary = {
  appName: 'Lexi',

  nav: {
    languages: '언어',
    compose: '붙여넣기',
    settings: '설정',
    wordbook: '단어장',
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
    toWordbook: '이 문서의 단어',
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

  pagination: {
    label: '페이지 이동',
    prev: '이전 쪽',
    next: '다음 쪽',
    range: '{total}개 중 {from}–{to}',
    size: '한 쪽에',
    unit: '개',
    readerSize: '한 쪽 단어 수',
    readerRange: '{page} / {pageCount} 쪽',
  },
  account: {
    title: '계정과 동기화',
    hint: '로그인하면 기기를 바꿔도 학습 기록이 이어집니다. 하지 않아도 이 기기에서만 그대로 쓸 수 있습니다.',
    notConfigured: 'Supabase 미설정 — 기록은 이 기기에만 남습니다.',
    checking: '세션을 확인하는 중…',
    emailPlaceholder: 'you@example.com',
    sendLink: '링크 받기',
    google: 'Google 계정으로 계속',
    linkSent: '메일에서 로그인 링크를 확인하세요.',
    signOut: '로그아웃',
    syncNow: '지금 동기화',
    syncStatus: '동기화',
    lastSynced: '마지막 동기화',
    errorRateLimit:
      '기본 메일 서버의 발송 한도를 넘었습니다. 기다려도 해결되지 않습니다 — Supabase → Project Settings → Authentication → Email 에 커스텀 SMTP(Resend)를 연결하세요.',
    errorNotAllowed: '이 서버에서는 가입이 닫혀 있습니다.',
    errorNotConfirmed: '먼저 이메일 주소를 인증한 뒤 다시 로그인하세요.',
    errorTooMany: '시도가 너무 많습니다. 잠시 뒤 다시 시도하세요.',
    status: {
      local: '로그인 안 함',
      syncing: '동기화 중…',
      synced: '최신 상태',
      error: '실패',
    },
  },
  statusBar: {
    label: '문서 진도',
    total: '단어 {count}개',
    percent: '{percent}% 표시',
    occurrences: '총 {count}회 등장',
    status: {
      known: '앎',
      unsure: '헷갈림',
      unknown: '모름',
      unmarked: '미표시',
    },
  },
  wordbook: {
    title: '단어장',
    pickLanguage: '보고 싶은 언어를 선택하세요.',
    summary: '단어 {count}개',
    scoped: '‘{title}’ 의 단어',
    search: '단어 검색',
    legend: '상태 버튼을 눌러 표시하세요.',
    noContext: '기록된 문맥이 없습니다.',
    group: {
      unmarked: '미표시',
      known: '아는 단어',
      unsure: '잘 모름',
      unknown: '모름',
    },
    empty: {
      unmarked: '아직 표시하지 않은 단어가 없습니다. 문서를 열어 단어를 모으세요.',
      known: '아는 단어로 표시한 단어가 없습니다.',
      unsure: '잘 모름으로 표시한 단어가 없습니다.',
      unknown: '모름으로 표시한 단어가 없습니다.',
    },
  },

  dictionary: {
    button: '사전',
    loading: '찾는 중…',
    notFound: '‘{word}’ 항목을 찾지 못했습니다.',
    failed: '사전에 연결하지 못했습니다.',
    failedStatus: '사전 오류 ({status}).',
    source: '위키낱말 · {license}',
    offline: '네트워크가 끊겨 이 기기에 저장돼 있던 결과입니다.',
    hide: '접기',
    baseForm: '기본형',
  },

  sentence: {
    translating: '번역 중…',
    retry: '다시 시도',
    identity: '원문이 이미 영어라 번역할 것이 없습니다.',
    failed: '번역에 실패했습니다. 다시 시도해 주세요.',
    failedStatus: '번역 서비스 오류 ({status}).',
    offline: '네트워크가 끊겨 이 기기에 저장돼 있던 결과입니다.',
  },

  settings: {
    title: '설정',
    textScale: '글자 크기',
    textScaleHint: '화면 전체를 함께 키워 {value}% 크기로 표시합니다.',
    textScalePreview: '다람쥐 헌 쳇바퀴에 타고파.',
    unmarkedDim: '표시 안 한 단어의 옅은 정도',
    unmarkedDimHint: '아직 표시하지 않은 단어를 본문보다 {value}% 옅게 보여줍니다. 모든 테마에 똑같이 적용됩니다.',
    dimStrong: '진하게',
    dimFaint: '옅게',
    reset: '기본값',
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