import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import path from "node:path";
import sharp from "sharp";

/**
 * Scene Pipeline (Фаза 6). Моки — только внешнее: prisma, Cloudinary, fal,
 * LLM. Настоящие — бриф-кламп, планировщик, цепочка декора, нарезка листа,
 * рендер и валидатор с ЖИВОЙ добытой спекой: тест проверяет, что прод-обвязка
 * доводит кадр до прохождения коридоров, а не что моки дергаются в порядке.
 */

const db = vi.hoisted(() => ({
  patternSpec: { findFirst: vi.fn(), findUnique: vi.fn() },
  normalizedLayer: { findUnique: vi.fn() },
  brand: { findUnique: vi.fn(), update: vi.fn() },
}));
const cloud = vi.hoisted(() => ({
  uploadBuffer: vi.fn(),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));
const fal = vi.hoisted(() => ({
  runPersonFal: vi.fn(),
  runBriaRemoveBg: vi.fn(),
}));
const llm = vi.hoisted(() => ({ chatCompletion: vi.fn() }));
const cache = vi.hoisted(() => ({
  fetchBuffer: vi.fn(),
  getOrCreateNormalizedLayer: vi.fn(),
}));
vi.mock("../src/lib/prisma.js", () => ({ prisma: db }));
vi.mock("../src/lib/cloudinary.js", () => cloud);
vi.mock("../src/lib/fal.js", () => fal);
vi.mock("../src/lib/nanogpt.js", () => llm);
vi.mock("../src/services/layerCache.js", () => cache);

import { renderSceneAsset, type ScenePipelineJob } from "../src/services/scenePipeline.js";
import { mineCorpus } from "../scripts/mine-pattern.js";
import type { PatternSpec } from "../src/lib/patternMiner.js";

const EXAMPLES = path.resolve(__dirname, "../../figma/crm-bundle/examples");

let spec: PatternSpec;

beforeAll(async () => {
  spec = (await mineCorpus(EXAMPLES)).spec;
}, 120_000);

// ---------------------------------------------------------------------------
// Синтетические слои (та же фактура, что в sceneRenderer.test)
// ---------------------------------------------------------------------------

async function blob(
  w: number,
  h: number,
  rgb: [number, number, number],
  shape: "rect" | "ellipse" = "rect",
): Promise<Buffer> {
  const data = Buffer.alloc(w * h * 4, 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (shape === "ellipse") {
        const dx = (x - w / 2) / (w / 2);
        const dy = (y - h / 2) / (h / 2);
        if (dx * dx + dy * dy > 1) continue;
      }
      const tex = (Math.floor(x / 6) + Math.floor(y / 6)) % 2 === 0 ? 50 : 0;
      const i = (y * w + x) * 4;
      data[i] = Math.min(255, rgb[0] + tex);
      data[i + 1] = Math.min(255, rgb[1] + tex);
      data[i + 2] = Math.min(255, rgb[2] + tex);
      data[i + 3] = 255;
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

/** Лист на 8 раздельных объектов — проходит порог нарезки. */
async function decorSheet(): Promise<Buffer> {
  const rects = [
    { x: 20, y: 20, w: 90, h: 90 },
    { x: 160, y: 30, w: 70, h: 70 },
    { x: 290, y: 20, w: 80, h: 60 },
    { x: 430, y: 40, w: 60, h: 80 },
    { x: 30, y: 220, w: 75, h: 65 },
    { x: 180, y: 230, w: 65, h: 75 },
    { x: 320, y: 220, w: 85, h: 55 },
    { x: 460, y: 240, w: 55, h: 55 },
  ];
  const data = Buffer.alloc(600 * 340 * 4, 0);
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const tex = (Math.floor(x / 6) + Math.floor(y / 6)) % 2 === 0 ? 50 : 0;
        const i = (y * 600 + x) * 4;
        data[i] = Math.min(255, 200 + tex);
        data[i + 1] = Math.min(255, 160 + tex);
        data[i + 2] = 40;
        data[i + 3] = 255;
      }
    }
  }
  return sharp(data, { raw: { width: 600, height: 340, channels: 4 } }).png().toBuffer();
}

// Палитра слоёв — тёплая и родственная, как у реального бренда: цветовой ключ
// (V14, ≤ 2–3 оттенков у корпуса) — проверка КАДРА, и синтетика из спорящих
// первичных цветов заваливала бы её независимо от работы пайплайна.
const BUFFERS: Record<string, () => Promise<Buffer>> = {
  "https://cdn/layers/person.png": () => blob(160, 300, [190, 90, 60], "ellipse"),
  "https://cdn/layers/item.png": () => blob(200, 300, [210, 150, 60], "ellipse"),
  "https://fal/sheet.png": () => decorSheet(),
};

function job(over: Partial<ScenePipelineJob> = {}): ScenePipelineJob {
  return {
    bundleId: "bun1",
    variantId: "v1",
    assetId: "a1",
    assetKey: "email",
    brandName: "Betnella(Men)",
    brandId: "br1",
    campaignPrompt: "Weekend reload promotion, golden coins and glowing lights",
    personLayerHash: "hp",
    itemLayerHash: "hi",
    canvas: { w: 1200, h: 600 },
    brandDecorRaw: null,
    commonDecorRaw: null,
    ...over,
  };
}

beforeEach(() => {
  for (const delegate of Object.values(db))
    for (const fn of Object.values(delegate)) (fn as ReturnType<typeof vi.fn>).mockReset();
  cloud.uploadBuffer.mockReset();
  fal.runPersonFal.mockReset();
  fal.runBriaRemoveBg.mockReset();
  llm.chatCompletion.mockReset();
  cache.fetchBuffer.mockReset();
  cache.getOrCreateNormalizedLayer.mockReset();

  db.patternSpec.findFirst.mockResolvedValue({
    id: "ps1",
    key: "pattern.email",
    version: 1,
    spec,
    corpusHash: spec.corpusHash,
    isActive: true,
    createdAt: new Date("2026-07-30"),
  });
  db.normalizedLayer.findUnique.mockImplementation(async ({ where }: { where: { sourceHash: string } }) =>
    where.sourceHash === "hp"
      ? { url: "https://cdn/layers/person.png", width: 160, height: 300 }
      : { url: "https://cdn/layers/item.png", width: 200, height: 300 },
  );
  db.brand.findUnique.mockResolvedValue({ id: "br1", decorUrls: null });
  db.brand.update.mockResolvedValue({});
  cache.fetchBuffer.mockImplementation(async (url: string) => {
    const make = BUFFERS[url];
    return make ? make() : null;
  });
  cloud.uploadBuffer.mockImplementation(async (_buf: Buffer, id: string) => ({
    success: true,
    secure_url: `https://cdn/out/${id}.png`,
    public_id: id,
  }));
  // Свет в тестах не генерируется (метрики света — предмет живого прогона);
  // лист декора — генерируется. Диспетчеризация по промпту.
  fal.runPersonFal.mockImplementation(async (prompt: string) =>
    prompt.startsWith("A set of small isolated casino promo props")
      ? { success: true, imageUrl: "https://fal/sheet.png" }
      : { success: false, error: "light disabled in test" },
  );
});

describe("renderSceneAsset — прод-обвязка нового пайплайна", () => {
  it("LLM недоступна → нейтральный бриф, лист по брифу не генерируется, кадр собирается из кусков ITEM либо валидатор честно объясняет провал", async () => {
    llm.chatCompletion.mockResolvedValue(null);
    const res = await renderSceneAsset(job());
    // Нейтральный бриф без концептов → single-item нарезка не даст 7+ объектов
    // декора — валидатор обязан провалить кадр с внятной причиной, а не
    // пропустить пустую сцену (D-C6).
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("scene validation failed");
      expect(res.metadata).toBeDefined();
    }
  }, 120_000);

  it("бриф от модели → лист декора, автосохранение в библиотеку, кадр проходит валидатор", async () => {
    llm.chatCompletion.mockResolvedValue(
      JSON.stringify({
        offer: { kind: "reload", headline: null, amount: null, extras: [], cta: null },
        mood: "celebration",
        season: null,
        decorConcepts: ["coin", "spark", "star"],
        paletteHint: "gold",
        lightMood: "bright warm golden burst",
        captions: [],
        confidence: { offer: 0.9, scene: 0.8 },
      }),
    );

    const res = await renderSceneAsset(job());
    expect(res.ok, res.ok ? "" : (res as { reason: string }).reason).toBe(true);
    if (!res.ok) return;

    // Детерминированный public id: повторный рендер перезаписывает, не плодит.
    const sceneUpload = cloud.uploadBuffer.mock.calls.find((c) => c[1] === "v1_email_scene_v1");
    expect(sceneUpload).toBeDefined();
    expect(res.imageUrl).toContain("v1_email_scene_v1");

    const meta = res.metadata as Record<string, unknown>;
    // Контракт метаданных (D-E1/Smartico): safe-зона в процентах, luminance
    // null — фон под текстом принадлежит письму (D-E5).
    expect(meta.safeZonePct).toEqual({ x: 25, y: 33.3, w: 47, h: 33.3 });
    expect(meta.luminance).toBeNull();
    expect(meta.recommendedTextColor).toBeNull();
    expect(meta.patternSpecVersion).toBe(1);
    expect(meta.corpusHash).toBe(spec.corpusHash);
    const validator = meta.validator as { passed: boolean; checks: unknown[] };
    expect(validator.passed).toBe(true);
    expect(validator.checks.length).toBeGreaterThan(10);
    const scene = meta.scene as Record<string, unknown>;
    expect(scene.briefSource).toBe("model");
    expect(scene.decorChain).toEqual(["generated:sheet", "split:item"]);
    expect(scene.generatedConcepts).toEqual(["coin", "spark", "star"]);

    // D-N8': нарезка листа ушла в библиотеку бренда с тегами концептов.
    expect(db.brand.update).toHaveBeenCalled();
    const written = db.brand.update.mock.calls[0]![0].data.decorUrls as Array<{
      concepts?: string[];
    }>;
    expect(written[0]!.concepts).toEqual(["coin", "spark", "star"]);
  }, 120_000);

  it("нет активной pattern-спеки → внятный отказ с рецептом", async () => {
    db.patternSpec.findFirst.mockResolvedValue(null);
    const res = await renderSceneAsset(job());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("mine-pattern");
  });

  it("сбой автосохранения библиотеки НЕ роняет рендер — кэш, а не предусловие", async () => {
    llm.chatCompletion.mockResolvedValue(
      JSON.stringify({
        offer: { kind: "reload", headline: null, amount: null, extras: [], cta: null },
        mood: "celebration",
        season: null,
        decorConcepts: ["coin", "spark"],
        paletteHint: null,
        lightMood: "warm glow",
        captions: [],
        confidence: { offer: 0.5, scene: 0.5 },
      }),
    );
    db.brand.update.mockRejectedValue(new Error("db down"));
    const res = await renderSceneAsset(job());
    expect(res.ok, res.ok ? "" : (res as { reason: string }).reason).toBe(true);
  }, 120_000);
});
