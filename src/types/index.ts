import type { SupportedLanguageCode } from '../lib/languages'

/** 배울 언어 코드. 화이트리스트에 있는 값만 문서 언어로 쓰인다. */
export type LanguageCode = SupportedLanguageCode

/** plan.txt 4줄: 단어 상태 3단계 */
export const WORD_STATUSES = ['known', 'unsure', 'unknown'] as const
export type WordStatus = (typeof WORD_STATUSES)[number]

/** 상태별 표시 기호 (plan.txt 3줄: ○ ◐ ●) */
export const STATUS_GLYPH: Record<WordStatus, string> = {
  known: '○',
  unsure: '◐',
  unknown: '●',
}

/** 원문을 단어/일반 텍스트로 분절한 조각. 오프셋은 항상 원문 기준 문자 인덱스. */
export type Segment =
  | {
      type: 'word'
      start: number
      end: number
      text: string
      lemma: string
      sentenceIndex: number
    }
  | { type: 'text'; start: number; end: number; text: string }

/** 문장 경계. plan.txt 6줄 문장 선택의 기본 단위. */
export type Sentence = {
  index: number
  start: number
  end: number
  text: string
}

export type Document = {
  id: string
  title: string
  languageCode: LanguageCode
  rawText: string
  createdAt: string
  updatedAt: string
  /**
   * 휴지통에 버린 시각. 없으면 살아 있는 문서.
   *
   * 바로 지우지 않는 이유: 실수로 지운 것을 되살릴 방법이 없다. 이 앱에서는
   * 문서를 열어 단어를 기록해 둔 것이 학습 상태의 근거라, 지우면 어디에도 안 남는다.
   */
  deletedAt?: string | null
  /**
   * 문서가 놓인 폴더. 없으면 폴더에 없다.
   *
   * 폴더로 옮기는 일은 문서를 고치는 일이 아니다 — updated_at 은 '마지막으로 본
   * 시각'이라 목록 날짜·정렬의 근거라서 건드리지 않는다. 옮긴 시각은
   * folderUpdatedAt 이 따로 찍는다 (문서 휴지통·별의 기록과 같은 모양이다).
   */
  folderId?: string | null
  /** 폴더로 옮긴 시각 — 병합에서 늦게 옮긴 쪽이 이긴다 */
  folderUpdatedAt?: string
}

/**
 * 폴더. 문서를 모으는 자리 — 상태 탭이나 언어와 달리 문서를 가두지 않는다.
 *
 * 중첩은 parentId 로 한다. 삭제는 바로 지우지 않고 deleted_at 을 찍는다 —
 * 문서 휴지통과 같은 이유로, 되살릴 방법이 없는 지우기는 하지 않는다.
 * (폴더를 지우면 그 안의 문서는 폴더의 부모로 옮겨 간다 — 사라지지 않는다.)
 */
export type Folder = {
  id: string
  name: string
  parentId: string | null
  createdAt: string
  updatedAt: string
  deletedAt?: string | null
}

/** 언어별 단어 상태. 같은 단어는 문서와 무관하게 전역 공유 (PLAN.md §4). */
export type WordState = {
  lemma: string
  languageCode: LanguageCode
  /**
   * 사용자가 고른 상태. 없으면 미표시.
   *
   * 표시를 없애도 행은 남긴다 — 별·읽은 기록이 같은 행에 있으므로, 상태를
   * 지운다고 행까지 지우면 별이 함께 사라진다. 서버에는 없는 상태로 둔다.
   */
  status?: WordStatus
  seenCount: number
  firstSeenAt: string
  lastSeenAt: string
  /**
   * 즐겨찾기. 상태와 독립이다 — 아는 단어에도, 미표시 단어에도 붙일 수 있다.
   *
   * 본문 표시(색)는 상태가 맡고 별은 별도로 둔다. 본문에 별을 그릴지는 아직
   * 정하지 않았으므로, 지금은 팝오버와 이후 단어장 탭에서만 쓴다.
   */
  favorite: boolean
  /** 별 스티커의 기울기(도) — 붙일 때마다 새로 뽑는다 */
  starAngle: number
  /** 별 스티커의 색 — 붙일 때와 색바꾸기 버튼으로 새로 뽑는다 */
  starColor: string
  /**
   * 퀴즈에서 상태 단추를 누른 횟수 — 항목별로 센다.
   *
   * **누른 단추** 를 센다 (저장된 상태가 아니다). '모름' 인 단어에서 '앎' 을 누르면
   * 상태는 '헷갈림' 이 되지만, 누른 것은 '앎' 이므로 '앎' 을 센다 — 상태를 세면
   * 이 경우가 '앎' 에 영영 안 잡힌다. 읽기 화면·단어장의 표시는 세지 않는다.
   * 지금은 저장만 해 두고 화면에 쓰지는 않는다 (나중에 쓰려고).
   */
  knownPresses: number
  unsurePresses: number
  unknownPresses: number
  /** 사용자가 적은 메모 — 어원·연상·내 예문. 없으면 비어 있다 */
  note?: string
  /** 메모를 마지막으로 고친 시각. 없으면 고친 적이 없다 (마지막으로 본 시각과 다르다) */
  noteUpdatedAt?: string
}