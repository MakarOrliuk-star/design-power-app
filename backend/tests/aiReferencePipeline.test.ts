import { describe, it, expect, beforeEach, vi } from "vitest";
import sharp from "sharp";

// Пайплайн ai_reference (TASK ai-reference + safe-zone/auto-heal): цикл
// 1+2 ретрая, auto-healing лучшего кандидата при провале приёмки, выход —
// ОДИН ассет (removeBg от финальной базы). Всё внешнее замокано; healing
// тестируется отдельно (aiHealing.test.ts), здесь — его встройка.

const db = vi.hoisted(() => ({
  bundle: { findUnique: vi.fn(), update: vi.fn() },
  bundleAsset: {
    update: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(),
  },
  variationReference: { findMany: vi.fn(), groupBy: vi.fn() },
  brand: { findMany: vi.fn(), findUnique: vi.fn() },
}));
const fal = vi.hoisted(() => ({
  runPersonFal: vi.fn(),
  runGptImage2Edit: vi.fn(),
  runBriaRemoveBg: vi.fn(),
  // TASK glow-fade-density: арт-директор выбирает цвет свечения (glowColor.ts).
  runVisionQa: vi.fn(),
}));
const fit = vi.hoisted(() => ({ fitAndStoreAsset: vi.fn() }));
const cloud = vi.hoisted(() => ({
  uploadFromUrl: vi.fn(),
  uploadBuffer: vi.fn(),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));
const cache = vi.hoisted(() => ({ fetchBuffer: vi.fn() }));
const validator = vi.hoisted(() => ({ validateAiAsset: vi.fn(), SIDE_FILL_MIN_RATIO: 0.12 }));
const reviewer = vi.hoisted(() => ({
  reviewComposition: vi.fn(),
  QA_REFS_SHOWN: 3,
  qaThreshold: vi.fn(() => 80),
}));
const style = vi.hoisted(() => ({ describeCampaignStyle: vi.fn() }));
const healing = vi.hoisted(() => ({ healComposition: vi.fn() }));

vi.mock("../src/lib/prisma.js", () => ({ prisma: db }));
vi.mock("../src/lib/fal.js", () => fal);
vi.mock("../src/lib/assetFit.js", () => fit);
vi.mock("../src/lib/cloudinary.js", () => cloud);
vi.mock("../src/services/layerCache.js", () => cache);
vi.mock("../src/lib/aiAssetValidator.js", () => validator);
vi.mock("../src/lib/vlmReviewer.js", () => reviewer);
vi.mock("../src/lib/styleAnchor.js", () => style);
vi.mock("../src/services/aiHealing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/aiHealing.js")>();
  return { ...actual, healComposition: healing.healComposition };
});

import {
  processAiReferenceAsset,
  loadAnchorContext,
  derivedAssetKeys,
  parentOfDerivedKey,
  derivedAssetLabel,
  buildAiReferencePrompt,
  buildSecondaryPrompt,
  formatGeometryHint,
  AI_REF_MAX_ATTEMPTS,
} from "../src/services/aiReferencePipeline.js";

// Реальный маленький PNG — база композиции (техвалидация работает с байтами).
const pngBuffer = await sharp({
  create: { width: 60, height: 30, channels: 3, background: { r: 255, g: 255, b: 255 } },
})
  .composite([
    {
      input: await sharp({
        create: { width: 10, height: 20, channels: 3, background: { r: 40, g: 40, b: 80 } },
      })
        .png()
        .toBuffer(),
      left: 0,
      top: 5,
    },
  ])
  .png()
  .toBuffer();

function refRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    presetId: "p1",
    brandName: "Betnella",
    assetKey: "email",
    imageUrl: `https://cdn/ref${i}.png`,
    publicId: `pid${i}`,
    width: 1200,
    height: 600,
    sortOrder: i,
    createdAt: new Date(),
  }));
}

const OPTS = {
  bundleId: "bun1",
  variantId: "v1",
  assetId: "a1",
  assetKey: "email",
  brandName: "Betnella(Men)", // референсы ищутся по БАЗОВОМУ имени
  targetW: 1200,
  targetH: 600,
};

/** Последний update родителя со статусом DONE (финальная запись ассета). */
function parentDoneCall() {
  return db.bundleAsset.update.mock.calls.find(
    (c) => (c[0] as { data: { status?: string } }).data.status === "DONE",
  )?.[0] as
    | {
        data: {
          imageUrl: string;
          metadata: {
            transparent?: boolean;
            qa: {
              qaPassed: boolean;
              chosenAttempt: number;
              healing?: { used: boolean; chosenAttempt: number | null; attempts: unknown[] };
            };
          };
        };
      }
    | undefined;
}

beforeEach(() => {
  for (const delegate of Object.values(db))
    for (const fn of Object.values(delegate)) (fn as ReturnType<typeof vi.fn>).mockReset();
  fal.runPersonFal.mockReset();
  fal.runGptImage2Edit.mockReset();
  fal.runBriaRemoveBg.mockReset();
  fal.runVisionQa.mockReset();
  fit.fitAndStoreAsset.mockReset();
  cloud.uploadFromUrl.mockReset();
  cloud.uploadBuffer.mockReset();
  cache.fetchBuffer.mockReset();
  validator.validateAiAsset.mockReset();
  reviewer.reviewComposition.mockReset();
  style.describeCampaignStyle.mockReset();
  healing.healComposition.mockReset();
  style.describeCampaignStyle.mockResolvedValue({
    text: "Campaign style to reproduce — Palette: neon purple.",
    anchor: { palette: "neon purple", character: "", props: "", lighting: "", rendering: "" },
  });

  db.bundle.findUnique.mockResolvedValue({
    neuralPrompt: "VIP Exclusive weekend BONUS",
    presetId: "p1",
    preset: { title: "VIP Exclusive", text: "VIP Exclusive campaign" },
  });
  db.variationReference.findMany.mockResolvedValue(refRows(6));
  db.bundleAsset.update.mockResolvedValue({});
  db.bundleAsset.updateMany.mockResolvedValue({});
  db.bundleAsset.deleteMany.mockResolvedValue({});
  db.bundleAsset.findMany.mockResolvedValue([{ status: "DONE" }]); // recompute
  db.bundle.update.mockResolvedValue({});
  // Сходство персонажа — настройка бренда; дефолт «вариативный» (null).
  db.brand.findUnique.mockResolvedValue({ characterFidelity: null });

  fal.runPersonFal.mockResolvedValue({ success: true, imageUrl: "https://fal/gen.png" });
  fal.runGptImage2Edit.mockResolvedValue({ success: true, imageUrl: "https://fal/gen.png" });
  fit.fitAndStoreAsset.mockResolvedValue({ ok: true, url: "https://cdn/fit.png", publicId: "fit" });
  cache.fetchBuffer.mockResolvedValue(pngBuffer);
  validator.validateAiAsset.mockResolvedValue({ passed: true, checks: [] });
  reviewer.reviewComposition.mockResolvedValue({ pass: true, score: 90, reasons: [] });
  fal.runBriaRemoveBg.mockResolvedValue({ success: true, imageUrl: "https://fal/nobg.png" });
  cloud.uploadFromUrl.mockResolvedValue({ success: true, secure_url: "https://cdn/stored.png" });
  // uploadBuffer заливает картинку С ЭФФЕКТАМИ — она и попадает в imageUrl.
  cloud.uploadBuffer.mockResolvedValue({ success: true, secure_url: "https://cdn/final.png" });
  fal.runVisionQa.mockResolvedValue({
    success: true,
    output: '{"hex": "#7FD4E0", "reason": "бирюза зонтика"}',
  });
});

describe("хелперы производных ключей (legacy, старые бандлы)", () => {
  it("derivedAssetKeys / parentOfDerivedKey / derivedAssetLabel", () => {
    expect(derivedAssetKeys("email")).toEqual(["email_notext", "email_transparent"]);
    expect(parentOfDerivedKey("email_notext")).toBe("email");
    expect(parentOfDerivedKey("email_transparent")).toBe("email");
    expect(parentOfDerivedKey("email")).toBeNull();
    expect(derivedAssetLabel("Email", "email_notext")).toBe("Email — без текста");
    expect(derivedAssetLabel("Email", "email_transparent")).toBe("Email — прозрачный фон");
  });
});

describe("buildAiReferencePrompt (A-1)", () => {
  it("промпт = бриф + композиционный контракт без текста", () => {
    const p = buildAiReferencePrompt("VIP weekend");
    expect(p).toContain("Campaign brief: VIP weekend.");
    expect(p).toContain("STRICTLY NO text");
    expect(p).toContain("FS, SCATTER, BONUS, VIP");
  });

  it("контракт A-2/A-6: белый фон, copy space по центру, три секции + depth of field", () => {
    const p = buildAiReferencePrompt("VIP weekend");
    expect(p).toContain("pure solid white");
    expect(p).toContain("COPY SPACE");
    expect(p).toContain("COMPLETELY EMPTY");
    expect(p).toContain("THREE sections");
    expect(p).toContain("depth of field");
  });
});

describe("processAiReferenceAsset — один ассет (TASK safe-zone/auto-heal)", () => {
  it("happy path: одна попытка → removeBg → единственный ассет с metadata.transparent", async () => {
    await processAiReferenceAsset(OPTS);

    // Референсы ищутся сначала по пулу тон-варианта (DI2-10), и он здесь есть.
    expect(db.variationReference.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { presetId: "p1", brandName: "Betnella(Men)", assetKey: "email" },
      }),
    );
    // Генерация: GPT Image 2 (A-7) с точным канвасом, banana не вызывается.
    expect(fal.runGptImage2Edit).toHaveBeenCalledTimes(1);
    expect(fal.runPersonFal).not.toHaveBeenCalled();
    const [args] = fal.runGptImage2Edit.mock.calls[0]!;
    expect(args.prompt).toContain("STRICTLY NO text");
    expect(args.prompt).toContain("LAYOUT GUIDE");
    expect(args.imageUrls).toHaveLength(7);
    expect(args.width).toBe(1200);
    expect(args.height).toBe(600);

    // Финал: removeBg от базы, аплоад с детерминированным public id.
    expect(fal.runBriaRemoveBg).toHaveBeenCalledWith("https://cdn/fit.png");
    expect(cloud.uploadFromUrl).toHaveBeenCalledWith(
      "https://fal/nobg.png",
      "v1_email_transparent",
      "bundles/bun1",
    );
    // Текст-слой не рендерится (uploadBuffer зовёт только layout-guide),
    // производные строки не создаются, healing на прошедшей приёмке не нужен.
    const uploadBufferIds = cloud.uploadBuffer.mock.calls.map((c) => c[1] as string);
    expect(uploadBufferIds).not.toContain("v1_email_text");
    expect(healing.healComposition).not.toHaveBeenCalled();

    const parent = parentDoneCall()!;
    // TASK glow-fade-density: в ассет идёт картинка С ЭФФЕКТАМИ (`_final`),
    // а чистый вырез (`_transparent`) остаётся источником для пере-применения.
    expect(parent.data.imageUrl).toBe("https://cdn/final.png");
    expect(cloud.uploadBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "v1_email_final",
      "bundles/bun1",
    );
    expect(parent.data.metadata.effects).toMatchObject({
      applied: true,
      glowHex: "#63CBD9", // #7FD4E0 после нормализации в коридор эталонов
      glowSource: "vlm",
      sourceUrl: "https://cdn/stored.png",
    });
    expect(parent.data.metadata.transparent).toBe(true);
    expect(parent.data.metadata.qa.qaPassed).toBe(true);
    expect(parent.data.metadata.qa.healing).toBeUndefined();

    // Legacy-строки трёх-ассетной схемы сносятся.
    expect(db.bundleAsset.deleteMany).toHaveBeenCalledWith({
      where: { variantId: "v1", assetKey: { in: ["email_notext", "email_transparent"] } },
    });
  });

  it(`B1: все ${AI_REF_MAX_ATTEMPTS} попытки провалили приёмку → healing лучшего кандидата, победитель — вылеченная версия`, async () => {
    reviewer.reviewComposition
      .mockResolvedValueOnce({ pass: false, score: 10, reasons: ["стиль"] })
      .mockResolvedValueOnce({ pass: false, score: 55, reasons: ["текст на баннере"] })
      .mockResolvedValueOnce({ pass: false, score: 30, reasons: ["анатомия"] });
    fit.fitAndStoreAsset
      .mockResolvedValueOnce({ ok: true, url: "https://cdn/try1.png", publicId: "t1" })
      .mockResolvedValueOnce({ ok: true, url: "https://cdn/try2.png", publicId: "t2" })
      .mockResolvedValueOnce({ ok: true, url: "https://cdn/try3.png", publicId: "t3" });
    healing.healComposition.mockResolvedValue({
      attempts: [
        { imageUrl: "https://cdn/heal1.png", score: 88, pass: true, reasons: [], tech: { passed: true, checks: [] } },
      ],
      winner: { imageUrl: "https://cdn/heal1.png", pass: true, score: 88, healingIndex: 0 },
    });

    await processAiReferenceAsset(OPTS);

    expect(fal.runGptImage2Edit).toHaveBeenCalledTimes(AI_REF_MAX_ATTEMPTS);
    // Лечится лучший по score (try2, score 55) по его замечаниям.
    expect(healing.healComposition).toHaveBeenCalledTimes(1);
    const [healArgs] = healing.healComposition.mock.calls[0]!;
    expect(healArgs.source).toEqual({
      imageUrl: "https://cdn/try2.png",
      score: 55,
      reasons: ["текст на баннере"],
    });
    expect(healArgs.publicIdBase).toBe("v1_email");
    expect(healArgs.brandName).toBe("Betnella");

    // Финальная база — вылеченная версия, приёмка пройдена.
    expect(fal.runBriaRemoveBg).toHaveBeenCalledWith("https://cdn/heal1.png");
    const parent = parentDoneCall()!;
    expect(parent.data.metadata.qa.qaPassed).toBe(true);
    expect(parent.data.metadata.qa.chosenAttempt).toBe(1);
    expect(parent.data.metadata.qa.healing).toEqual(
      expect.objectContaining({ used: true, chosenAttempt: 0 }),
    );
  });

  it("B4: healing не помог → лучший исходный кандидат с warning (qaPassed=false), ассет DONE", async () => {
    reviewer.reviewComposition
      .mockResolvedValueOnce({ pass: false, score: 10, reasons: ["стиль"] })
      .mockResolvedValueOnce({ pass: false, score: 55, reasons: ["монеты в центре"] })
      .mockResolvedValueOnce({ pass: false, score: 30, reasons: ["анатомия"] });
    fit.fitAndStoreAsset
      .mockResolvedValueOnce({ ok: true, url: "https://cdn/try1.png", publicId: "t1" })
      .mockResolvedValueOnce({ ok: true, url: "https://cdn/try2.png", publicId: "t2" })
      .mockResolvedValueOnce({ ok: true, url: "https://cdn/try3.png", publicId: "t3" });
    healing.healComposition.mockResolvedValue({
      attempts: [
        { imageUrl: "https://cdn/heal1.png", score: 40, pass: false, reasons: ["хуже"], tech: { passed: true, checks: [] } },
        { imageUrl: "https://cdn/heal2.png", score: 20, pass: false, reasons: ["ещё хуже"], tech: { passed: true, checks: [] } },
      ],
      winner: { imageUrl: "https://cdn/try2.png", pass: false, score: 55, healingIndex: null },
    });

    await processAiReferenceAsset(OPTS);

    expect(fal.runBriaRemoveBg).toHaveBeenCalledWith("https://cdn/try2.png");
    const parent = parentDoneCall()!;
    expect(parent.data.metadata.qa.qaPassed).toBe(false);
    expect(parent.data.metadata.qa.chosenAttempt).toBe(1); // score 55 — лучший
    expect(parent.data.metadata.qa.healing).toEqual(
      expect.objectContaining({ used: false, chosenAttempt: null }),
    );
    expect((parent.data.metadata.qa.healing!.attempts as unknown[]).length).toBe(2);
  });

  it("env-откат A-7: AI_REF_IMAGE_MODEL=fal-ai/nano-banana-2 → путь banana (16:9)", async () => {
    vi.stubEnv("AI_REF_IMAGE_MODEL", "fal-ai/nano-banana-2");
    try {
      await processAiReferenceAsset(OPTS);
      expect(fal.runGptImage2Edit).not.toHaveBeenCalled();
      expect(fal.runPersonFal).toHaveBeenCalledTimes(1);
      const [, urls, aspect, model] = fal.runPersonFal.mock.calls[0]!;
      expect(urls).toHaveLength(7);
      expect(aspect).toBe("16:9");
      expect(model).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("меньше 5 референсов → FAILED с причиной, legacy-строки снесены, генерация не вызывается", async () => {
    db.variationReference.findMany.mockResolvedValue(refRows(3));
    await processAiReferenceAsset(OPTS);
    expect(fal.runGptImage2Edit).not.toHaveBeenCalled();
    expect(fal.runPersonFal).not.toHaveBeenCalled();
    const failCall = db.bundleAsset.update.mock.calls[0]![0] as {
      data: { status: string; errorMessage: string };
    };
    expect(failCall.data.status).toBe("FAILED");
    expect(failCall.data.errorMessage).toContain("нужно >= 5");
    expect(db.bundleAsset.deleteMany).toHaveBeenCalledWith({
      where: { variantId: "v1", assetKey: { in: ["email_notext", "email_transparent"] } },
    });
  });

  it("нет выбранной вариации → FAILED", async () => {
    db.bundle.findUnique.mockResolvedValue({ neuralPrompt: "", presetId: null, preset: null });
    await processAiReferenceAsset(OPTS);
    const failCall = db.bundleAsset.update.mock.calls[0]![0] as { data: { errorMessage: string } };
    expect(failCall.data.errorMessage).toContain("не выбрана вариация");
  });

  it("сбой removeBg валит ассет: прозрачная версия — единственный результат", async () => {
    fal.runBriaRemoveBg.mockResolvedValue({ success: false, error: "HTTP 500" });
    await processAiReferenceAsset(OPTS);
    expect(parentDoneCall()).toBeUndefined();
    const failCall = db.bundleAsset.update.mock.calls[0]![0] as {
      data: { status: string; errorMessage: string };
    };
    expect(failCall.data.status).toBe("FAILED");
    expect(failCall.data.errorMessage).toContain("removeBg");
  });

  it("сбой аплоада прозрачной версии → FAILED", async () => {
    cloud.uploadFromUrl.mockResolvedValue({ success: false, error: "cloudinary down" });
    await processAiReferenceAsset(OPTS);
    expect(parentDoneCall()).toBeUndefined();
    const failCall = db.bundleAsset.update.mock.calls[0]![0] as {
      data: { status: string; errorMessage: string };
    };
    expect(failCall.data.status).toBe("FAILED");
    expect(failCall.data.errorMessage).toContain("transparent upload");
  });
});

// ---------------------------------------------------------------------------
// Мультиформатное промо (TASK multiformat-promo): якорь email → push/pop-up
// в едином стиле кампании (DI2-3), без safe-зоны и схемы-раскладки (DI2-4).
// ---------------------------------------------------------------------------

describe("formatGeometryHint / buildSecondaryPrompt (DI2-3/DI2-4)", () => {
  it("геометрия формата человекочитаема — модель не видит канвас из промпта", () => {
    expect(formatGeometryHint("Push", 1024, 512)).toBe(
      "Target format: Push — a wide horizontal banner, 1024×512 px (2:1).",
    );
    expect(formatGeometryHint("Pop-up", 800, 600)).toContain(
      "nearly square banner, 800×600 px (4:3)",
    );
  });

  it("промпт зависимого формата: якорь-эталон, запрет копировать раскладку, без copy space", () => {
    const p = buildSecondaryPrompt({
      variationText: "VIP weekend",
      styleText: "Campaign style to reproduce — Palette: neon purple.",
      hasAnchor: true,
      formatLabel: "Push",
      targetW: 1024,
      targetH: 512,
    });
    expect(p).toContain("Campaign brief: VIP weekend.");
    expect(p).toContain("Target format: Push");
    expect(p).toContain("Palette: neon purple");
    expect(p).toContain("APPROVED anchor creative");
    expect(p).toContain("Do NOT copy its layout");
    expect(p).toContain("NO reserved copy space");
    expect(p).toContain("STRICTLY NO text");
    // Требований якорного контракта тут быть не должно.
    expect(p).not.toContain("COPY SPACE");
    expect(p).not.toContain("THREE sections");
  });

  // TASK glow-fade-density, задание 3 (DI3-9/DI3-11): прежний контракт сам
  // просил «anchor prop group» и «fill the canvas» — отсюда и брался перегруз.
  it("контракт плотности: число предметов, запрет крупных объектов, стиль рефов", () => {
    const p = buildSecondaryPrompt({
      variationText: "VIP weekend",
      styleText: "",
      hasAnchor: true,
      formatLabel: "Pop-up",
      targetW: 800,
      targetH: 600,
      maxProps: 12,
    });
    expect(p).toContain("between 8 and 12 props");
    expect(p).toContain("fewer than 8 floating props is wrong, more than 12 is wrong too");
    expect(p).toContain("AT MOST ONE larger prop");
    expect(p).toContain("no slot machines");
    expect(p).toContain("no treasure chests");
    expect(p).toContain("must feel abundant, not empty");
    // Стилистику предметов не меняем — только количество и калибр (DI3-11).
    expect(p).toContain("same visual family as the brand's reference banners");
    // Правка 2026-08-13: набор предметов свой, а не копия якоря; мелкие
    // пропсы можно резать краем — так построены эталоны дизайнера.
    expect(p).toContain("do NOT reproduce the anchor creative's set of objects");
    expect(p).toContain("the way a designer would");
    expect(p).toContain("may run past the canvas edges and be partly cropped");
    expect(p).toContain("reaching into all four corners");
    expect(p).toContain("APPROVED anchor creative");
    // Прежние формулировки, порождавшие перегруз, ушли.
    expect(p).not.toContain("anchor prop group");
    expect(p).not.toContain("fill the canvas with a clear focal hierarchy");
  });

  // Правка 2026-08-13 по эталонам `push1/push2 ok`: у широкого формата
  // предметы КРУПНЫЕ и часть уходит за героя — у почти квадратного pop-up нет.
  it("широкий формат (push) просит крупные предметы и глубину, pop-up — нет", () => {
    const make = (targetW: number, targetH: number) =>
      buildSecondaryPrompt({
        variationText: "",
        styleText: "",
        hasAnchor: true,
        formatLabel: "F",
        targetW,
        targetH,
      });
    const push = make(1024, 512); // 2:1
    expect(push).toContain("SCALE (wide format)");
    expect(push).toContain("oversized volumetric casino lettering");
    expect(push).toContain("may sit BEHIND");

    const popup = make(800, 600); // 4:3
    expect(popup).toContain("clearly smaller than the character");
    expect(popup).not.toContain("SCALE (wide format)");
    expect(popup).not.toContain("may sit BEHIND");
  });

  it("предметы требуют разных планов резкости — «как у дизайнера»", () => {
    const p = buildSecondaryPrompt({
      variationText: "",
      styleText: "",
      hasAnchor: true,
      formatLabel: "Push",
      targetW: 1024,
      targetH: 512,
    });
    expect(p).toContain("FOCUS");
    expect(p).toContain("OUT OF FOCUS");
    expect(p).toContain("motion blur");
    expect(p).toContain("the hero is always the sharpest");
    // Предметы на земле остаются запрещены, а «за героем» — уже нет.
    expect(p).toContain("no props standing on the ground");
    expect(p).not.toContain("stacked behind");
  });

  it("лимит предметов нормализуется: мусор и выход за границы → безопасное число", () => {
    const build = (maxProps?: number) =>
      buildSecondaryPrompt({
        variationText: "",
        styleText: "",
        hasAnchor: true,
        formatLabel: "Push",
        targetW: 1024,
        targetH: 512,
        ...(maxProps !== undefined ? { maxProps } : {}),
      });
    expect(build()).toContain("between 8 and 14 props"); // дефолт
    expect(build(2)).toContain("between 8 and 8 props"); // ниже нормы
    expect(build(999)).toContain("between 8 and 24 props"); // потолок
  });

  // Правка 2026-08-13: DI3-10 («email не трогаем») отменено заказчиком —
  // композиция email тоже выходила пустой. Раскладка при этом прежняя.
  it("якорный контракт требует богатых боковых групп, сохраняя пустой центр", () => {
    const anchor = buildAiReferencePrompt("VIP weekend");
    expect(anchor).toContain("RICHNESS");
    expect(anchor).toContain("5 to 8 overlapping props");
    expect(anchor).toContain("empty space belongs ONLY in the middle");
    // Инварианты якоря на месте: copy space и три секции.
    expect(anchor).toContain("COPY SPACE");
    expect(anchor).toContain("THREE sections");
    // Правила зависимых форматов в якорь не протекли.
    expect(anchor).not.toContain("no slot machines");
  });

  it("пол героя из тон-варианта попадает в промпт обоих форматов", () => {
    expect(buildAiReferencePrompt("VIP", "male")).toContain("the main character is a MAN");
    expect(buildAiReferencePrompt("VIP", "female")).toContain("the main character is a WOMAN");
    // Бренд без суффикса пола пункт не получает — персонажа задают референсы.
    expect(buildAiReferencePrompt("VIP")).not.toContain("HERO GENDER");
    const push = buildSecondaryPrompt({
      variationText: "VIP",
      styleText: "",
      hasAnchor: true,
      formatLabel: "Push",
      targetW: 1024,
      targetH: 512,
      gender: "male",
    });
    expect(push).toContain("the main character is a MAN");
    expect(push).toContain("never a woman");
  });

  it("без якоря (старый бандл) блок STYLE SOURCE снимается", () => {
    const p = buildSecondaryPrompt({
      variationText: "VIP weekend",
      styleText: "",
      hasAnchor: false,
      formatLabel: "Pop-up",
      targetW: 800,
      targetH: 600,
    });
    expect(p).not.toContain("APPROVED anchor creative");
    expect(p).toContain("The images are reference banners");
  });
});

describe("processAiReferenceAsset — зависимый формат (DI2-3)", () => {
  const PUSH_OPTS = {
    ...OPTS,
    assetId: "a2",
    assetKey: "push",
    targetW: 1024,
    targetH: 512,
    isAnchor: false,
    formatLabel: "Push",
    anchor: {
      imageUrl: "https://cdn/email-base.png",
      styleText: "Campaign style to reproduce — Palette: neon purple.",
    },
  };

  it("якорь идёт первой картинкой, схема-раскладка не используется, стиль не переснимается", async () => {
    await processAiReferenceAsset(PUSH_OPTS);

    // Референсы берутся из пула СВОЕГО формата (DI2-2) и своего тона (DI2-10).
    expect(db.variationReference.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { presetId: "p1", brandName: "Betnella(Men)", assetKey: "push" },
      }),
    );
    const [args] = fal.runGptImage2Edit.mock.calls[0]!;
    expect(args.imageUrls[0]).toBe("https://cdn/email-base.png");
    expect(args.imageUrls).toHaveLength(7); // якорь + 6 референсов формата
    expect(args.prompt).toContain("APPROVED anchor creative");
    expect(args.prompt).not.toContain("LAYOUT GUIDE");
    expect(args.width).toBe(1024);
    expect(args.height).toBe(512);
    // Описание стиля снимается только с якоря — здесь оно уже готово.
    expect(style.describeCampaignStyle).not.toHaveBeenCalled();
  });

  it("чек чистого центра не выполняется, приёмка идёт профилем secondary (DI2-4)", async () => {
    await processAiReferenceAsset(PUSH_OPTS);
    // Чек центра у зависимых не выполняется, зато выполняется чек боков:
    // у них центр занят героем, а пустовать не должны края (правка 2026-08-13).
    const techOpts = validator.validateAiAsset.mock.calls[0]![3];
    expect(techOpts).toEqual({ minSideFill: 0.12 });
    const [qaArgs] = reviewer.reviewComposition.mock.calls[0]!;
    expect(qaArgs.profile).toBe("secondary");
    expect(qaArgs.anchorUrl).toBe("https://cdn/email-base.png");
  });

  it("в метаданных нет safe-зоны, зато виден источник стиля", async () => {
    await processAiReferenceAsset(PUSH_OPTS);
    const parent = parentDoneCall()! as unknown as { data: { metadata: Record<string, unknown> } };
    expect(parent.data.metadata.safeZonePct).toBeNull();
    expect(parent.data.metadata.campaignAnchorUrl).toBe("https://cdn/email-base.png");
    expect(parent.data.metadata.styleAnchorUsed).toBe(true);
  });

  // TASK glow-fade-density: у кампании ОДИН цвет свечения (DI3-4).
  it("цвет свечения наследуется от якоря без отдельного запроса к модели", async () => {
    await processAiReferenceAsset({
      ...PUSH_OPTS,
      anchor: { ...PUSH_OPTS.anchor, glowHex: "#63CBD9" },
    });
    expect(fal.runVisionQa).not.toHaveBeenCalled();
    const parent = parentDoneCall()! as unknown as {
      data: { metadata: { effects: Record<string, unknown> } };
    };
    expect(parent.data.metadata.effects).toMatchObject({
      applied: true,
      glowHex: "#63CBD9",
      glowSource: "inherited",
    });
  });

  it("якорь без цвета (старый бандл) → зависимый формат выбирает цвет сам", async () => {
    await processAiReferenceAsset(PUSH_OPTS);
    expect(fal.runVisionQa).toHaveBeenCalledTimes(1);
    const parent = parentDoneCall()! as unknown as {
      data: { metadata: { effects: Record<string, unknown> } };
    };
    expect(parent.data.metadata.effects).toMatchObject({ glowSource: "vlm" });
  });

  it("подсказка цвета текста ставится только у якоря — у зависимых safe-зоны нет", async () => {
    await processAiReferenceAsset(PUSH_OPTS);
    const parent = parentDoneCall()! as unknown as {
      data: { metadata: Record<string, unknown> };
    };
    expect(parent.data.metadata.recommendedTextColor).toBeNull();
  });

  it("лимит предметов уходит и в промпт, и в приёмку одним числом (DI3-9)", async () => {
    await processAiReferenceAsset({ ...PUSH_OPTS, maxProps: 10 });
    const [genArgs] = fal.runGptImage2Edit.mock.calls[0]!;
    expect(genArgs.prompt).toContain("between 8 and 10 props");
    const [qaArgs] = reviewer.reviewComposition.mock.calls[0]!;
    expect(qaArgs.maxProps).toBe(10);
  });
});

// Правка 2026-08-13 (боевая ошибка «center: 90% белого (порог 95%), 3 попыток»
// → ассет FAILED → каскад «якорный ассет не сгенерирован»). Провал ТЕХНИКИ на
// всех попытках раньше ронял ассет, минуя auto-healing, хотя лечение «убери
// объекты из центра» — ровно тот случай, ради которого healing и делался.
describe("провал техвалидации на всех попытках лечится, а не роняет ассет", () => {
  const techFail = (ratio: number) => ({
    passed: false,
    centerRatio: ratio,
    checks: [
      { key: "center", passed: false, detail: `чистая зона: ${Math.round(ratio * 100)}% белого (порог 95%)` },
    ],
  });

  it("лечение запускается от самого чистого кадра, ассет становится DONE", async () => {
    validator.validateAiAsset
      .mockResolvedValueOnce(techFail(0.6))
      .mockResolvedValueOnce(techFail(0.9)) // лучший — его и лечим
      .mockResolvedValueOnce(techFail(0.75));
    fit.fitAndStoreAsset
      .mockResolvedValueOnce({ ok: true, url: "https://cdn/try1.png", publicId: "t1" })
      .mockResolvedValueOnce({ ok: true, url: "https://cdn/try2.png", publicId: "t2" })
      .mockResolvedValueOnce({ ok: true, url: "https://cdn/try3.png", publicId: "t3" });
    healing.healComposition.mockResolvedValue({
      attempts: [{ imageUrl: "https://cdn/healed.png", score: 88, pass: true, reasons: [], tech: null }],
      winner: { imageUrl: "https://cdn/healed.png", pass: true, score: 88, healingIndex: 0 },
    });

    const result = await processAiReferenceAsset(OPTS);

    expect(result.ok).toBe(true);
    const [healArgs] = healing.healComposition.mock.calls[0]!;
    expect(healArgs.source.imageUrl).toBe("https://cdn/try2.png");
    expect(healArgs.source.reasons[0]).toContain("center:");
    const parent = parentDoneCall()!;
    expect(parent.data.status).toBe("DONE");
    expect(parent.data.metadata.qa.qaPassed).toBe(true);
  });

  it("ни одного кадра вообще (генерация не отдала картинку) → FAILED как раньше", async () => {
    fal.runGptImage2Edit.mockResolvedValue({ success: false, error: "HTTP 500" });
    const result = await processAiReferenceAsset(OPTS);
    expect(result.ok).toBe(false);
    expect(healing.healComposition).not.toHaveBeenCalled();
  });
});

// Правка 2026-08-13 (запрос заказчика): «у части брендов персонаж один в
// один, у части немного вариативный» — настройка Brand.characterFidelity.
describe("сходство персонажа с референсами", () => {
  it("дефолт — вариативный: пол и черты варьируются, персонаж узнаваем", async () => {
    db.brand.findUnique.mockResolvedValue({ characterFidelity: null });
    await processAiReferenceAsset(OPTS);
    const [args] = fal.runGptImage2Edit.mock.calls[0]!;
    expect(args.prompt).toContain("give this particular creative its own take");
    expect(args.prompt).not.toContain("fixed asset");
    const [qaArgs] = reviewer.reviewComposition.mock.calls[0]!;
    expect(qaArgs.fidelity).toBe("variant");
  });

  it("exact — маскот копируется один в один, приёмка судит строго", async () => {
    db.brand.findUnique.mockResolvedValue({ characterFidelity: "exact" });
    await processAiReferenceAsset(OPTS);
    const [args] = fal.runGptImage2Edit.mock.calls[0]!;
    expect(args.prompt).toContain("reproduce the character from the reference banners EXACTLY");
    expect(args.prompt).toContain("fixed asset");
    const [qaArgs] = reviewer.reviewComposition.mock.calls[0]!;
    expect(qaArgs.fidelity).toBe("exact");
  });

  it("настройка читается по ТОЧНОМУ имени тон-варианта, не по базовому", async () => {
    await processAiReferenceAsset(OPTS);
    expect(db.brand.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { name: "Betnella(Men)" } }),
    );
  });
});

// TASK glow-fade-density (DI3-15): эффекты — оформление поверх готового
// ассета, поэтому их отключение и их сбой не должны менять судьбу ассета.
describe("эффекты в пайплайне: рубильники и fail-open", () => {
  it("галки выключены → в ассет идёт чистый вырез, uploadBuffer не зовётся", async () => {
    await processAiReferenceAsset({ ...OPTS, effects: { glow: false, fade: false } });
    const parent = parentDoneCall()! as unknown as {
      data: { imageUrl: string; metadata: { effects: Record<string, unknown> } };
    };
    expect(parent.data.imageUrl).toBe("https://cdn/stored.png");
    expect(parent.data.metadata.effects).toMatchObject({ applied: false, glowHex: null });
    expect(cloud.uploadBuffer).not.toHaveBeenCalled();
    expect(fal.runVisionQa).not.toHaveBeenCalled();
  });

  it("выключено только свечение → цвет не запрашивается, фейд применяется", async () => {
    await processAiReferenceAsset({ ...OPTS, effects: { glow: false } });
    expect(fal.runVisionQa).not.toHaveBeenCalled();
    const parent = parentDoneCall()! as unknown as {
      data: { imageUrl: string; metadata: { effects: Record<string, unknown> } };
    };
    expect(parent.data.imageUrl).toBe("https://cdn/final.png");
    expect(parent.data.metadata.effects).toMatchObject({ applied: true, glowHex: null });
  });

  it("сбой заливки эффектов не валит ассет — остаётся чистый вырез с причиной", async () => {
    cloud.uploadBuffer.mockResolvedValue({ success: false, error: "HTTP 500" });
    const result = await processAiReferenceAsset(OPTS);
    expect(result.ok).toBe(true);
    const parent = parentDoneCall()! as unknown as {
      data: { imageUrl: string; status: string; metadata: { effects: Record<string, unknown> } };
    };
    expect(parent.data.status).toBe("DONE");
    expect(parent.data.imageUrl).toBe("https://cdn/stored.png");
    expect(parent.data.metadata.effects).toMatchObject({
      applied: false,
      error: "upload: HTTP 500",
    });
  });

  it("сбой vision при выборе цвета не валит ассет — цвет берётся фолбэком", async () => {
    fal.runVisionQa.mockResolvedValue({ success: false, error: "HTTP 500" });
    const result = await processAiReferenceAsset(OPTS);
    expect(result.ok).toBe(true);
    const parent = parentDoneCall()! as unknown as {
      data: { metadata: { effects: Record<string, unknown> } };
    };
    expect(parent.data.metadata.effects).toMatchObject({ applied: true, glowSource: "fallback" });
  });
});

describe("processAiReferenceAsset — якорь отдаёт стиль дальше (DI2-3)", () => {
  it("сохраняет базу ДО removeBg и описание стиля, возвращает их процессору", async () => {
    const result = await processAiReferenceAsset(OPTS);

    expect(style.describeCampaignStyle).toHaveBeenCalledWith("https://cdn/fit.png");
    expect(result).toEqual({
      ok: true,
      baseUrl: "https://cdn/fit.png",
      styleText: "Campaign style to reproduce — Palette: neon purple.",
      // Цвет свечения кампании уходит процессору вместе со стилем (DI3-4).
      glowHex: "#63CBD9",
    });
    const parent = parentDoneCall()! as unknown as {
      data: { metadata: Record<string, unknown> & { qa: Record<string, unknown> } };
    };
    // Якорем становится белая база, а НЕ прозрачная картинка ассета.
    expect(parent.data.metadata.qa.baseUrl).toBe("https://cdn/fit.png");
    expect(parent.data.metadata.qa.threshold).toBe(80);
    expect(parent.data.metadata.styleAnchor).toContain("neon purple");
    expect(parent.data.metadata.isStyleAnchor).toBe(true);
  });

  it("сбой описания стиля не валит якорь (fail-open)", async () => {
    style.describeCampaignStyle.mockResolvedValue({ text: "", anchor: null, error: "HTTP 500" });
    const result = await processAiReferenceAsset(OPTS);
    expect(result.ok).toBe(true);
    expect(result.styleText).toBe("");
  });

  it("провал ассета возвращает ok:false — зависимые форматы не поедут", async () => {
    fal.runBriaRemoveBg.mockResolvedValue({ success: false, error: "HTTP 500" });
    expect(await processAiReferenceAsset(OPTS)).toEqual({ ok: false });
  });
});

describe("тон-варианты в пайплайне (DI2-10)", () => {
  it("пул тона пуст → в генерацию идут общие референсы бренда", async () => {
    db.variationReference.findMany
      .mockResolvedValueOnce([]) // Betnella(Men) — своего пула нет
      .mockResolvedValueOnce(refRows(6)); // Betnella — общий пул

    await processAiReferenceAsset(OPTS);

    expect(db.variationReference.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { presetId: "p1", brandName: "Betnella", assetKey: "email" },
      }),
    );
    expect(fal.runGptImage2Edit).toHaveBeenCalledTimes(1);
  });
});

describe("loadAnchorContext (DI2-9)", () => {
  it("берёт белую базу из metadata.qa.baseUrl", async () => {
    db.bundleAsset.findUnique.mockResolvedValue({
      status: "DONE",
      imageUrl: "https://cdn/email-transparent.png",
      metadata: { styleAnchor: "Palette: neon purple.", qa: { baseUrl: "https://cdn/base.png" } },
    });
    expect(await loadAnchorContext("v1", "email")).toEqual({
      imageUrl: "https://cdn/base.png",
      styleText: "Palette: neon purple.",
    });
  });

  // TASK glow-fade-density (DI3-4): цвет свечения кампании переживает
  // одиночную регенерацию push — он читается из metadata якоря.
  it("подхватывает цвет свечения якоря", async () => {
    db.bundleAsset.findUnique.mockResolvedValue({
      status: "DONE",
      imageUrl: "https://cdn/email-transparent.png",
      metadata: {
        styleAnchor: "Palette: neon purple.",
        qa: { baseUrl: "https://cdn/base.png" },
        effects: { glowHex: "#63CBD9" },
      },
    });
    expect(await loadAnchorContext("v1", "email")).toEqual({
      imageUrl: "https://cdn/base.png",
      styleText: "Palette: neon purple.",
      glowHex: "#63CBD9",
    });
  });

  it("старый бандл без baseUrl → фолбэк на картинку ассета с пометкой", async () => {
    db.bundleAsset.findUnique.mockResolvedValue({
      status: "DONE",
      imageUrl: "https://cdn/email-transparent.png",
      metadata: { qa: {} },
    });
    expect(await loadAnchorContext("v1", "email")).toEqual({
      imageUrl: "https://cdn/email-transparent.png",
      styleText: "",
      fallback: true,
    });
  });

  it("якорь не готов (FAILED / нет строки) → контекста нет", async () => {
    db.bundleAsset.findUnique.mockResolvedValue({
      status: "FAILED",
      imageUrl: null,
      metadata: null,
    });
    expect(await loadAnchorContext("v1", "email")).toBeNull();
    db.bundleAsset.findUnique.mockResolvedValue(null);
    expect(await loadAnchorContext("v1", "email")).toBeNull();
  });
});
