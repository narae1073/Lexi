import type { SupportedLanguageCode } from '../../lib/languages'

export type StarterStory = {
  /** Native greeting shown as a chip in the first-run welcome card. */
  greeting: string
  /** The document title and story text are in the language being learned. */
  title: string
  /** First one or two sentences, shown in the welcome card. */
  snippet: string
  body: string
}

/**
 * Original first-read stories, one per supported language.
 *
 * They are deliberately short and concrete: common verbs, a single everyday
 * scene, and enough repeated context to make the first word marks useful. The
 * stories are not translated copies of one another; each reads naturally in its
 * own language.
 */
export const STARTER_STORIES = {
  en: {
    greeting: 'Hello!',
    title: 'A Morning in the Park',
    snippet: 'The sun rises over the park. A small dog runs across the grass.',
    body:
      'The sun rises over the park. A small dog runs across the grass. A girl throws a red ball. The dog brings it back with a happy bark. They sit on a bench and share an apple. It is a good morning.',
  },
  ja: {
    greeting: 'こんにちは！',
    title: 'あさのさんぽ',
    snippet: 'ミナはあさ早くおきます。まどをあけて、すずしい空気をすいます。',
    body:
      'ミナはあさ早くおきます。まどをあけて、すずしい空気をすいます。テーブルの上にパンとコーヒーがあります。ねこがドアのそばでまっています。いっしょにこうえんをさんぽします。空は青くて、とても気持ちがいいです。',
  },
  ko: {
    greeting: '안녕하세요!',
    title: '아침 산책',
    snippet: '지민은 아침 일찍 일어납니다. 창문을 열고 시원한 공기를 마십니다.',
    body:
      '지민은 아침 일찍 일어납니다. 창문을 열고 시원한 공기를 마십니다. 식탁 위에는 빵과 커피가 있습니다. 고양이가 문 옆에서 기다립니다. 둘은 함께 공원을 산책합니다. 하늘은 맑고 기분이 좋습니다.',
  },
  es: {
    greeting: '¡Hola!',
    title: 'La mañana de Lucía',
    snippet: 'Lucía se despierta temprano. Abre la ventana y siente el aire fresco.',
    body:
      'Lucía se despierta temprano. Abre la ventana y siente el aire fresco. En la cocina hay pan y café. Su gato espera junto a la puerta. Juntos salen a dar un paseo. El parque está tranquilo y el sol brilla.',
  },
  fr: {
    greeting: 'Bonjour !',
    title: 'Le matin de Camille',
    snippet: 'Camille se réveille tôt. Elle ouvre la fenêtre et respire l’air frais.',
    body:
      'Camille se réveille tôt. Elle ouvre la fenêtre et respire l’air frais. Sur la table, il y a du pain et du café. Son chat attend près de la porte. Ensemble, ils partent faire une petite promenade. Le parc est calme et le ciel est bleu.',
  },
  de: {
    greeting: 'Hallo!',
    title: 'Mias Morgen',
    snippet: 'Mia wacht früh auf. Sie öffnet das Fenster und hört die Vögel.',
    body:
      'Mia wacht früh auf. Sie öffnet das Fenster und hört die Vögel. In der Küche duftet frischer Kaffee. Ihr Hund wartet schon an der Tür. Zusammen gehen sie in den Park. Die Sonne scheint und der Morgen ist ruhig.',
  },
  pt: {
    greeting: 'Olá!',
    title: 'A manhã de Sofia',
    snippet: 'Sofia acorda cedo. Ela abre a janela e sente o ar fresco.',
    body:
      'Sofia acorda cedo. Ela abre a janela e sente o ar fresco. Na cozinha há pão e café. O seu gato espera junto à porta. Juntos vão dar uma pequena caminhada. O parque está calmo e o sol brilha.',
  },
  zh: {
    greeting: '你好！',
    title: '小雨的早晨',
    snippet: '小雨很早就起床了。她打开窗户，呼吸新鲜的空气。',
    body:
      '小雨很早就起床了。她打开窗户，呼吸新鲜的空气。桌子上有面包和咖啡。她的小猫在门边等着。他们一起去公园散步。今天天气很好，阳光很温暖。',
  },
} satisfies Record<SupportedLanguageCode, StarterStory>
