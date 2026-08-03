/**
 * Набор тест-промптов для Creative Brief (Задание 3, Фаза 2, TASK §8).
 *
 * Живёт в `src/`, а не в тестах, потому что используется дважды: офлайн — для
 * проверки гарантий клампа (`tests/creativeBriefCorpus.test.ts`), и вживую —
 * скриптом `scripts/try-brief.ts`, когда доступен ключ модели.
 *
 * Первый промпт — реальный, от заказчика; остальные подобраны так, чтобы
 * закрыть классы, на которых система ломается: неполные (нет суммы, нет CTA),
 * противоречащие каркасу и бренду, пограничные (пустой, очень длинный, не по-
 * английски, число не в том поле).
 */

export type PromptKind = "complete" | "mood-only" | "incomplete" | "contradictory" | "edge";

export interface TestPrompt {
  id: string;
  kind: PromptKind;
  prompt: string;
  /** Должна ли сумма «500 000$» пережить кламп (то есть есть ли её цифры). */
  expectAmount: boolean;
  /** Какие из надписей «BIG WIN» / «SCATTER» законны для этого промпта. */
  expectCaptions: string[];
  /** D-N16: выживает ли headline «UP TO». По умолчанию — нет: выдумка режется. */
  expectHeadline?: boolean;
  /** D-N16: выживает ли CTA «Start Playing». По умолчанию — нет. */
  expectCta?: boolean;
  /** D-N16: какие из extras («+50 FREE SPINS») законны. По умолчанию — никакие. */
  expectExtras?: string[];
  /** Зачем этот промпт в наборе. */
  why: string;
}

export const TEST_PROMPTS: TestPrompt[] = [
  {
    id: "weekend-reload",
    kind: "mood-only",
    prompt:
      "Weekend reload promotion with bonus energy and action. Bright celebratory mood, golden coins and glowing lights, high-energy casino excitement.",
    expectAmount: false,
    expectCaptions: [],
    why: "реальный промпт заказчика: настроение без единой цифры и без надписей",
  },
  {
    id: "full-offer",
    kind: "complete",
    prompt: "Deposit bonus UP TO 500 000$ plus 50 free spins. CTA: Start Playing. BIG WIN mood.",
    expectAmount: true,
    expectCaptions: ["BIG WIN"],
    expectHeadline: true,
    expectCta: true,
    expectExtras: ["+50 FREE SPINS"],
    why: "полный оффер: сумма, экстра, CTA и надпись — всё названо",
  },
  {
    id: "amount-no-cta",
    kind: "incomplete",
    prompt: "Reload bonus 500 000$ this weekend only.",
    expectAmount: true,
    expectCaptions: [],
    why: "сумма есть, CTA и надписей нет — модель не должна их дорисовать",
  },
  {
    id: "cta-no-amount",
    kind: "incomplete",
    prompt: "Cashback week. Big rewards for loyal players. CTA: Claim now.",
    expectAmount: false,
    expectCaptions: [],
    why: "«big rewards» без числа: типовой случай, где выдумывается сумма",
  },
  {
    id: "scatter-caption",
    kind: "complete",
    prompt: "Free spins drop with SCATTER symbols everywhere, purple neon mood.",
    expectAmount: false,
    expectCaptions: ["SCATTER"],
    why: "надпись названа в промпте, сумма — нет: частичное совпадение",
  },
  {
    id: "both-captions",
    kind: "complete",
    prompt: "Tournament finale: BIG WIN energy, SCATTER symbols, golden confetti.",
    expectAmount: false,
    expectCaptions: ["BIG WIN", "SCATTER"],
    why: "обе надписи законны — проверяет, что кламп не режет лишнего",
  },
  {
    id: "sakura-season",
    kind: "complete",
    prompt: "Sakura season free spins. Soft pink petals, spring mood, gentle light.",
    expectAmount: false,
    expectCaptions: [],
    why: "сезон задан явно — должен попасть в свет и декор, а не в предмет",
  },
  {
    id: "halloween",
    kind: "complete",
    prompt: "Halloween drop and win. Dark purple mystery, fog, eerie green glow.",
    expectAmount: false,
    expectCaptions: [],
    why: "тёмное настроение: проверка, что свет не сводится к «золотому»",
  },
  {
    id: "vip-luxury",
    kind: "complete",
    prompt: "VIP club invitation. Understated luxury, deep black and champagne gold.",
    expectAmount: false,
    expectCaptions: [],
    why: "люкс без шума — противоположность «celebration» по плотности декора",
  },
  {
    id: "empty",
    kind: "edge",
    prompt: "",
    expectAmount: false,
    expectCaptions: [],
    why: "пустой промпт: всё должно уйти в дефолты бренда, ничего не выдумано",
  },
  {
    id: "single-word",
    kind: "edge",
    prompt: "cashback",
    expectAmount: false,
    expectCaptions: [],
    why: "одно слово — минимальный осмысленный вход",
  },
  {
    id: "russian",
    kind: "edge",
    prompt: "Перезагрузка выходного дня, золотые монеты, праздничное настроение, много света.",
    expectAmount: false,
    expectCaptions: [],
    why: "промпт не по-английски: менеджеры пишут на русском",
  },
  {
    id: "russian-with-amount",
    kind: "edge",
    prompt: "Бонус на депозит до 500 000$ и 50 фриспинов. Кнопка: Играть.",
    expectAmount: true,
    expectCaptions: [],
    why: "цифры не зависят от языка — сумма обязана пережить кламп",
  },
  {
    id: "wrong-amount",
    kind: "contradictory",
    prompt: "Deposit bonus up to 1 000 000$ this month.",
    expectAmount: false,
    expectCaptions: [],
    why: "в промпте ДРУГАЯ сумма: подмена опаснее выдумки на пустом месте",
  },
  {
    id: "layout-demand",
    kind: "contradictory",
    prompt:
      "Put the character on the left and the item on the right. Text across the full width, no empty centre.",
    expectAmount: false,
    expectCaptions: [],
    why: "промпт требует другой раскладки — каркас в брифе не представлен вовсе",
  },
  {
    id: "foreign-character",
    kind: "contradictory",
    prompt: "Use a blonde croupier woman instead of the brand mascot, red dress, casino table.",
    expectAmount: false,
    expectCaptions: [],
    why: "промпт меняет персонажа бренда — этого поля в брифе нет (D-N10)",
  },
  {
    id: "long-rambling",
    kind: "edge",
    prompt:
      "So this week we want something really special for our players, the kind of promotion that feels generous and warm, maybe like a holiday, with a lot of light and a feeling of abundance, nothing too aggressive, but definitely celebratory, and it should feel premium but still fun and approachable for newer players who are just discovering the platform.",
    expectAmount: false,
    expectCaptions: [],
    why: "многословный бриф без единого факта: проверка на выдумывание конкретики",
  },
  {
    id: "percent-not-amount",
    kind: "edge",
    prompt: "100% match bonus on your next deposit.",
    expectAmount: false,
    expectCaptions: [],
    why: "число есть, но это процент, а не сумма 500 000 — подмена поля",
  },
];
