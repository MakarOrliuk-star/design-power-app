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
  brand: { findMany: vi.fn() },
}));
const fal = vi.hoisted(() => ({
  runPersonFal: vi.fn(),
  runGptImage2Edit: vi.fn(),
  runBriaRemoveBg: vi.fn(),
}));
const fit = vi.hoisted(() => ({ fitAndStoreAsset: vi.fn() }));
const cloud = vi.hoisted(() => ({
  uploadFromUrl: vi.fn(),
  uploadBuffer: vi.fn(),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));
const cache = vi.hoisted(() => ({ fetchBuffer: vi.fn() }));
const validator = vi.hoisted(() => ({ validateAiAsset: vi.fn() }));
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

  fal.runPersonFal.mockResolvedValue({ success: true, imageUrl: "https://fal/gen.png" });
  fal.runGptImage2Edit.mockResolvedValue({ success: true, imageUrl: "https://fal/gen.png" });
  fit.fitAndStoreAsset.mockResolvedValue({ ok: true, url: "https://cdn/fit.png", publicId: "fit" });
  cache.fetchBuffer.mockResolvedValue(pngBuffer);
  validator.validateAiAsset.mockResolvedValue({ passed: true, checks: [] });
  reviewer.reviewComposition.mockResolvedValue({ pass: true, score: 90, reasons: [] });
  fal.runBriaRemoveBg.mockResolvedValue({ success: true, imageUrl: "https://fal/nobg.png" });
  cloud.uploadFromUrl.mockResolvedValue({ success: true, secure_url: "https://cdn/stored.png" });
  cloud.uploadBuffer.mockResolvedValue({ success: true, secure_url: "https://cdn/text.png" });
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

    // Референсы ищутся по базовому имени бренда (stripGenderName).
    expect(db.variationReference.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { presetId: "p1", brandName: "Betnella", assetKey: "email" },
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
    expect(parent.data.imageUrl).toBe("https://cdn/stored.png");
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

    // Референсы берутся из пула СВОЕГО формата (DI2-2).
    expect(db.variationReference.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { presetId: "p1", brandName: "Betnella", assetKey: "push" },
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
    const techOpts = validator.validateAiAsset.mock.calls[0]![3];
    expect(techOpts).toEqual({});
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
});

describe("processAiReferenceAsset — якорь отдаёт стиль дальше (DI2-3)", () => {
  it("сохраняет базу ДО removeBg и описание стиля, возвращает их процессору", async () => {
    const result = await processAiReferenceAsset(OPTS);

    expect(style.describeCampaignStyle).toHaveBeenCalledWith("https://cdn/fit.png");
    expect(result).toEqual({
      ok: true,
      baseUrl: "https://cdn/fit.png",
      styleText: "Campaign style to reproduce — Palette: neon purple.",
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
