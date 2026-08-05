import { describe, it, expect, beforeEach, vi } from "vitest";
import sharp from "sharp";

// Пайплайн ai_reference (TASK ai-reference): цикл 1+2 ретрая, best-of по
// score, семейство из трёх ассетов. Всё внешнее замокано, sharp — настоящий
// (композит текст-слоя работает с реальными байтами).

const db = vi.hoisted(() => ({
  bundle: { findUnique: vi.fn(), update: vi.fn() },
  bundleAsset: {
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    findMany: vi.fn(),
  },
  variationReference: { findMany: vi.fn(), groupBy: vi.fn() },
  brand: { findMany: vi.fn() },
}));
const fal = vi.hoisted(() => ({ runPersonFal: vi.fn(), runBriaRemoveBg: vi.fn() }));
const fit = vi.hoisted(() => ({ fitAndStoreAsset: vi.fn() }));
const cloud = vi.hoisted(() => ({
  uploadFromUrl: vi.fn(),
  uploadBuffer: vi.fn(),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));
const cache = vi.hoisted(() => ({ fetchBuffer: vi.fn() }));
const validator = vi.hoisted(() => ({ validateAiAsset: vi.fn() }));
const reviewer = vi.hoisted(() => ({ reviewComposition: vi.fn(), QA_REFS_SHOWN: 3 }));
const renderTokenMock = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/prisma.js", () => ({ prisma: db }));
vi.mock("../src/lib/fal.js", () => fal);
vi.mock("../src/lib/assetFit.js", () => fit);
vi.mock("../src/lib/cloudinary.js", () => cloud);
vi.mock("../src/services/layerCache.js", () => cache);
vi.mock("../src/lib/aiAssetValidator.js", () => validator);
vi.mock("../src/lib/vlmReviewer.js", () => reviewer);
vi.mock("../src/lib/typography3d.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/typography3d.js")>();
  return { ...actual, renderToken: renderTokenMock };
});

import {
  processAiReferenceAsset,
  derivedAssetKeys,
  parentOfDerivedKey,
  derivedAssetLabel,
  buildAiReferencePrompt,
  pickOverlayToken,
  DEFAULT_OVERLAY_TOKEN,
  AI_REF_MAX_ATTEMPTS,
} from "../src/services/aiReferencePipeline.js";

// Реальный маленький PNG — база композиции и отрендеренный токен.
// Белый фон с группой в левой секции (вне чистой зоны): доводка центра (A-5)
// на таком кадре не срабатывает — у неё отдельные тесты (centerCleanup.test).
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
const tokenPng = await sharp({
  create: { width: 20, height: 10, channels: 4, background: { r: 255, g: 200, b: 0, alpha: 1 } },
})
  .png()
  .toBuffer();

function refRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    presetId: "p1",
    brandName: "Betnella",
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

beforeEach(() => {
  for (const delegate of Object.values(db))
    for (const fn of Object.values(delegate)) (fn as ReturnType<typeof vi.fn>).mockReset();
  fal.runPersonFal.mockReset();
  fal.runBriaRemoveBg.mockReset();
  fit.fitAndStoreAsset.mockReset();
  cloud.uploadFromUrl.mockReset();
  cloud.uploadBuffer.mockReset();
  cache.fetchBuffer.mockReset();
  validator.validateAiAsset.mockReset();
  reviewer.reviewComposition.mockReset();
  renderTokenMock.mockReset();

  db.bundle.findUnique.mockResolvedValue({
    neuralPrompt: "VIP Exclusive weekend BONUS",
    presetId: "p1",
    preset: { title: "VIP Exclusive", text: "VIP Exclusive campaign" },
  });
  db.variationReference.findMany.mockResolvedValue(refRows(6));
  db.bundleAsset.update.mockResolvedValue({});
  db.bundleAsset.updateMany.mockResolvedValue({});
  db.bundleAsset.upsert.mockResolvedValue({});
  db.bundleAsset.findMany.mockResolvedValue([{ status: "DONE" }]); // recompute
  db.bundle.update.mockResolvedValue({});

  fal.runPersonFal.mockResolvedValue({ success: true, imageUrl: "https://fal/gen.png" });
  fit.fitAndStoreAsset.mockResolvedValue({ ok: true, url: "https://cdn/fit.png", publicId: "fit" });
  cache.fetchBuffer.mockResolvedValue(pngBuffer);
  validator.validateAiAsset.mockResolvedValue({ passed: true, checks: [] });
  reviewer.reviewComposition.mockResolvedValue({ pass: true, score: 90, reasons: [] });
  fal.runBriaRemoveBg.mockResolvedValue({ success: true, imageUrl: "https://fal/nobg.png" });
  cloud.uploadFromUrl.mockResolvedValue({ success: true, secure_url: "https://cdn/stored.png" });
  cloud.uploadBuffer.mockResolvedValue({ success: true, secure_url: "https://cdn/text.png" });
  renderTokenMock.mockResolvedValue({ png: tokenPng, width: 20, height: 10 });
});

describe("хелперы производных ключей", () => {
  it("derivedAssetKeys / parentOfDerivedKey / derivedAssetLabel", () => {
    expect(derivedAssetKeys("email")).toEqual(["email_notext", "email_transparent"]);
    expect(parentOfDerivedKey("email_notext")).toBe("email");
    expect(parentOfDerivedKey("email_transparent")).toBe("email");
    expect(parentOfDerivedKey("email")).toBeNull();
    expect(derivedAssetLabel("Email", "email_notext")).toBe("Email — без текста");
    expect(derivedAssetLabel("Email", "email_transparent")).toBe("Email — прозрачный фон");
  });
});

describe("buildAiReferencePrompt / pickOverlayToken (A-1)", () => {
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

  it("токен — первый КАПС из брифа, иначе дефолт", () => {
    expect(pickOverlayToken("Get your VIP reward now")).toBe("VIP");
    expect(pickOverlayToken("обычный текст без капса")).toBe(DEFAULT_OVERLAY_TOKEN);
  });
});

describe("processAiReferenceAsset", () => {
  it("happy path: одна попытка → родитель с текстом + notext + transparent, qaPassed", async () => {
    await processAiReferenceAsset(OPTS);

    // Референсы ищутся по базовому имени бренда (stripGenderName).
    expect(db.variationReference.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { presetId: "p1", brandName: "Betnella" } }),
    );
    // Генерация: дефолтная модель (null), аспект 16:9 для 1200×600.
    // Референсы + схема-раскладка последним слотом (A-6).
    expect(fal.runPersonFal).toHaveBeenCalledTimes(1);
    const [prompt, urls, aspect, model] = fal.runPersonFal.mock.calls[0]!;
    expect(prompt).toContain("STRICTLY NO text");
    expect(prompt).toContain("LAYOUT GUIDE");
    expect(urls).toHaveLength(7);
    expect(aspect).toBe("16:9");
    expect(model).toBeNull();

    // Производные строки семейства: notext + transparent, обе DONE.
    const upsertKeys = db.bundleAsset.upsert.mock.calls.map(
      (c) => (c[0] as { where: { variantId_assetKey: { assetKey: string } } }).where.variantId_assetKey.assetKey,
    );
    expect(upsertKeys).toEqual(["email_notext", "email_transparent"]);

    // Родитель: DONE, картинка с текст-слоем, qa в метаданных.
    const parentCall = db.bundleAsset.update.mock.calls.find(
      (c) => (c[0] as { data: { status?: string } }).data.status === "DONE",
    )![0] as { data: { imageUrl: string; metadata: { qa: { qaPassed: boolean }; overlayToken: string } } };
    expect(parentCall.data.imageUrl).toBe("https://cdn/text.png");
    expect(parentCall.data.metadata.qa.qaPassed).toBe(true);
    expect(parentCall.data.metadata.overlayToken).toBe("VIP");
  });

  it(`DI-R10: все ${AI_REF_MAX_ATTEMPTS} попытки провалили приёмку → лучший по score с пометкой`, async () => {
    reviewer.reviewComposition
      .mockResolvedValueOnce({ pass: false, score: 10, reasons: ["стиль"] })
      .mockResolvedValueOnce({ pass: false, score: 55, reasons: ["текст на баннере"] })
      .mockResolvedValueOnce({ pass: false, score: 30, reasons: ["анатомия"] });
    fit.fitAndStoreAsset
      .mockResolvedValueOnce({ ok: true, url: "https://cdn/try1.png", publicId: "t1" })
      .mockResolvedValueOnce({ ok: true, url: "https://cdn/try2.png", publicId: "t2" })
      .mockResolvedValueOnce({ ok: true, url: "https://cdn/try3.png", publicId: "t3" });

    await processAiReferenceAsset(OPTS);

    expect(fal.runPersonFal).toHaveBeenCalledTimes(AI_REF_MAX_ATTEMPTS);
    const parentCall = db.bundleAsset.update.mock.calls.find(
      (c) => (c[0] as { data: { status?: string } }).data.status === "DONE",
    )![0] as {
      data: { metadata: { qa: { qaPassed: boolean; chosenAttempt: number } } };
    };
    expect(parentCall.data.metadata.qa.qaPassed).toBe(false);
    expect(parentCall.data.metadata.qa.chosenAttempt).toBe(1); // score 55 — лучший
    // База деривативов — лучшая попытка, не последняя.
    expect(cloud.uploadFromUrl).toHaveBeenCalledWith(
      "https://cdn/try2.png",
      "v1_email_notext",
      "bundles/bun1",
    );
  });

  it("меньше 5 референсов → семейство FAILED с причиной, генерация не вызывается", async () => {
    db.variationReference.findMany.mockResolvedValue(refRows(3));
    await processAiReferenceAsset(OPTS);
    expect(fal.runPersonFal).not.toHaveBeenCalled();
    const failCall = db.bundleAsset.update.mock.calls[0]![0] as {
      data: { status: string; errorMessage: string };
    };
    expect(failCall.data.status).toBe("FAILED");
    expect(failCall.data.errorMessage).toContain("нужно >= 5");
    // Производные прошлого запуска тоже падают — семейство целиком.
    expect(db.bundleAsset.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { variantId: "v1", assetKey: { in: ["email_notext", "email_transparent"] } },
      }),
    );
  });

  it("нет выбранной вариации → FAILED", async () => {
    db.bundle.findUnique.mockResolvedValue({ neuralPrompt: "", presetId: null, preset: null });
    await processAiReferenceAsset(OPTS);
    const failCall = db.bundleAsset.update.mock.calls[0]![0] as { data: { errorMessage: string } };
    expect(failCall.data.errorMessage).toContain("не выбрана вариация");
  });

  it("сбой removeBg роняет только transparent-строку, семейство остаётся DONE", async () => {
    fal.runBriaRemoveBg.mockResolvedValue({ success: false, error: "HTTP 500" });
    await processAiReferenceAsset(OPTS);
    const transparent = db.bundleAsset.upsert.mock.calls
      .map((c) => c[0] as { where: { variantId_assetKey: { assetKey: string } }; create: { status: string; errorMessage: string | null } })
      .find((c) => c.where.variantId_assetKey.assetKey === "email_transparent")!;
    expect(transparent.create.status).toBe("FAILED");
    expect(transparent.create.errorMessage).toContain("removeBg");
    const parentDone = db.bundleAsset.update.mock.calls.some(
      (c) => (c[0] as { data: { status?: string } }).data.status === "DONE",
    );
    expect(parentDone).toBe(true);
  });

  it("сбой текст-слоя деградирует родителя к базе без текста (overlayError в метаданных)", async () => {
    renderTokenMock.mockRejectedValue(new Error("font missing"));
    await processAiReferenceAsset(OPTS);
    const parentCall = db.bundleAsset.update.mock.calls.find(
      (c) => (c[0] as { data: { status?: string } }).data.status === "DONE",
    )![0] as { data: { imageUrl: string; metadata: { overlayError: string | null } } };
    expect(parentCall.data.imageUrl).toBe("https://cdn/stored.png"); // notext-база
    expect(parentCall.data.metadata.overlayError).toContain("font missing");
  });
});
