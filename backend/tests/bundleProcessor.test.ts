import { describe, it, expect, beforeEach, vi } from "vitest";

// Heavy deps are mocked: prisma, fal, cloudinary, image probing, the person
// prompt-writer (redis) and the queue. The pipeline logic itself runs for real.
const db = vi.hoisted(() => ({
  bundleBrandVariant: { findUnique: vi.fn(), update: vi.fn() },
  bundleAsset: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  brand: { findUnique: vi.fn() },
  promptTemplate: { findFirst: vi.fn() },
  layoutSpec: { findFirst: vi.fn(), findUnique: vi.fn() },
  normalizedLayer: { findUnique: vi.fn() },
}));
const fal = vi.hoisted(() => ({
  runPersonFal: vi.fn(),
  runBriaExpand: vi.fn(),
  runBriaRemoveBg: vi.fn(),
}));
const cloud = vi.hoisted(() => ({
  uploadFromUrl: vi.fn(),
  uploadFromUrlTransformed: vi.fn(),
  uploadBuffer: vi.fn(),
  composeLayersUrl: vi.fn(() => "https://res.cloudinary/composed.png"),
  // Pure URL math — kept real so the emitted @1x delivery URL is asserted for
  // what it actually is, not for a stub.
  withTransform: vi.fn((url: string, transform: string) => {
    const marker = "/image/upload/";
    const at = url.indexOf(marker);
    if (at < 0) return url;
    return `${url.slice(0, at + marker.length)}${transform}/${url.slice(at + marker.length)}`;
  }),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));
const imageSize = vi.hoisted(() => ({
  probeImageSize: vi.fn(),
  nearestFalAspect: vi.fn(() => "16:9"),
}));
const queue = vi.hoisted(() => ({ addBulk: vi.fn() }));
const recompute = vi.hoisted(() => vi.fn());
const layerCache = vi.hoisted(() => ({ getOrCreateNormalizedLayer: vi.fn(), fetchBuffer: vi.fn() }));
const engine = vi.hoisted(() => ({ composeAsset: vi.fn() }));
const split = vi.hoisted(() => ({ splitLayerPieces: vi.fn() }));
const validator = vi.hoisted(() => ({
  validateComposedAsset: vi.fn(),
  personLayerSanity: vi.fn(),
}));
// Задание 3, Фаза 6: scene-пайплайн живёт своим модулем и тестируется своим
// файлом; здесь проверяется только МАРШРУТИЗАЦИЯ по флагу спеки.
const scenePipeline = vi.hoisted(() => ({ renderSceneAsset: vi.fn() }));
// TASK multiformat-promo: сам ai_reference-пайплайн покрыт своим файлом —
// здесь проверяется ПОРЯДОК (якорь → зависимые) и передача якорного контекста.
const aiRef = vi.hoisted(() => ({
  processAiReferenceAsset: vi.fn(),
  loadAnchorContext: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: db }));
vi.mock("../src/lib/fal.js", () => fal);
vi.mock("../src/lib/cloudinary.js", () => cloud);
vi.mock("../src/lib/imageSize.js", () => imageSize);
vi.mock("../src/services/layerCache.js", () => layerCache);
vi.mock("../src/lib/composeEngine.js", () => engine);
vi.mock("../src/lib/layerSplit.js", () => split);
vi.mock("../src/lib/assetValidator.js", () => validator);
vi.mock("../src/queues/index.js", () => ({ getBundleQueue: () => queue }));
vi.mock("../src/queues/person.processor.js", () => ({
  buildPersonPromptMemoized: vi.fn(async (_b: string, brand: string, text: string) => `PP(${brand}): ${text}`),
}));
// Хелперы порядка (resolveStyleAnchorKey / dependentAiReferenceAssets) —
// настоящие: правило выбора якоря должно совпадать с боевым.
vi.mock("../src/services/bundle.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/bundle.service.js")>();
  return { ...actual, recomputeBundleStatus: recompute };
});
vi.mock("../src/services/scenePipeline.js", () => scenePipeline);
vi.mock("../src/services/aiReferencePipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/aiReferencePipeline.js")>();
  return {
    ...actual,
    processAiReferenceAsset: aiRef.processAiReferenceAsset,
    loadAnchorContext: aiRef.loadAnchorContext,
  };
});

import { EMAIL_HERO_V1, EMAIL_HERO_V2 } from "../src/services/layoutSpec.js";
import {
  backgroundPrompt,
  buildBundleItemPrompt,
  compositionPrompt,
  computeBleedPlacement,
  computeCanvasPlacement,
  computeLayerPlacements,
  processEditAssetJob,
  processPrepareVariantJob,
  processRenderAssetJob,
} from "../src/queues/bundle.processor.js";

beforeEach(() => {
  for (const delegate of Object.values(db))
    for (const fn of Object.values(delegate)) (fn as ReturnType<typeof vi.fn>).mockReset();
  fal.runPersonFal.mockReset();
  fal.runBriaExpand.mockReset();
  fal.runBriaRemoveBg.mockReset();
  cloud.uploadFromUrl.mockReset();
  cloud.uploadFromUrlTransformed.mockReset();
  cloud.composeLayersUrl.mockClear();
  imageSize.probeImageSize.mockReset();
  queue.addBulk.mockReset();
  recompute.mockReset();
  layerCache.getOrCreateNormalizedLayer.mockReset();
  layerCache.fetchBuffer.mockReset();
  engine.composeAsset.mockReset();
  split.splitLayerPieces.mockReset();
  // Default: the item layer holds two separate props (hero + one prop).
  split.splitLayerPieces.mockResolvedValue([
    { png: Buffer.from("piece0"), width: 300, height: 400, area: 90000 },
    { png: Buffer.from("piece1"), width: 120, height: 120, area: 12000 },
  ]);
  cloud.uploadBuffer.mockReset();
  aiRef.processAiReferenceAsset.mockReset();
  aiRef.loadAnchorContext.mockReset();
  aiRef.processAiReferenceAsset.mockResolvedValue({ ok: true, baseUrl: "https://cdn/base.png", styleText: "Palette: neon." });
  validator.validateComposedAsset.mockReset();
  validator.personLayerSanity.mockReset();
  // Defaults: sane layer, passing validation (tests override per case).
  validator.personLayerSanity.mockReturnValue({ ok: true, reason: "" });
  validator.validateComposedAsset.mockResolvedValue({ passed: true, checks: [], failedKeys: [] });
  scenePipeline.renderSceneAsset.mockReset();
});

/**
 * BE Test — canvas fitting math (D5): the generated image is scaled to FIT the
 * exact mask canvas and centered; Bria outpaints the margins.
 */
describe("computeCanvasPlacement", () => {
  it("email: 16:9 (1024×576) → 1200×600 leaves side margins to outpaint", () => {
    const p = computeCanvasPlacement(1024, 576, 1200, 600);
    expect(p).toEqual({ canvasW: 1200, canvasH: 600, imgW: 1067, imgH: 600, originX: 67, originY: 0 });
  });

  it("push: 16:9 (1024×576) → 1024×512 shrinks and centers horizontally", () => {
    const p = computeCanvasPlacement(1024, 576, 1024, 512);
    expect(p.imgH).toBe(512);
    expect(p.imgW).toBe(910);
    expect(p.originX).toBe(57);
    expect(p.originY).toBe(0);
  });

  it("popup: same-ratio 4:3 (1024×768) → 800×600 is full-bleed", () => {
    const p = computeCanvasPlacement(1024, 768, 800, 600);
    expect(p).toEqual({ canvasW: 800, canvasH: 600, imgW: 800, imgH: 600, originX: 0, originY: 0 });
  });

  it("bleed placement pads the canvas so the outpaint seam can be cropped away", () => {
    const p = computeBleedPlacement(1024, 576, 1200, 600, 32);
    expect(p).toEqual({ canvasW: 1264, canvasH: 664, imgW: 1067, imgH: 600, originX: 99, originY: 32 });
  });
});

/**
 * BE Test — mask-layout directives (D10, figma/crm-bundle stencils): email
 * protects the central text zone; push/popup explicitly do not.
 */
describe("compositionPrompt", () => {
  it("email: person at the right EDGE / items at the left EDGE / empty central half", () => {
    const p = compositionPrompt("email", { hasTemplate: true, hasItem: true, neuralPrompt: "Weekend reload" });
    expect(p).toContain("RIGHT EDGE");
    expect(p).toContain("LEFT EDGE");
    expect(p).toContain("CENTRAL HALF of the canvas must stay COMPLETELY EMPTY");
    expect(p).toContain("first reference image as the background template");
    expect(p).toContain("Campaign brief: Weekend reload.");
    // Anti-frame directive (живой прогон показал прозрачные поля/рамку).
    expect(p).toContain("FULL-BLEED");
  });

  it("push/popup: centered character, no protected zones", () => {
    const push = compositionPrompt("push", { hasTemplate: false, hasItem: true, neuralPrompt: "" });
    expect(push).toContain("CENTER holding a glowing focal medallion");
    expect(push).toContain("NO protected empty area");
    // Without a template the person is the FIRST reference.
    expect(push).toContain("first reference image — same identity");

    const popup = compositionPrompt("popup", { hasTemplate: false, hasItem: false, neuralPrompt: "" });
    expect(popup).toContain("main character in the CENTER");
    expect(popup).toContain("no protected text zones");
  });

  it("unknown asset keys (future bundle types) get a generic layout", () => {
    const p = compositionPrompt("story", { hasTemplate: false, hasItem: true, neuralPrompt: "x" });
    expect(p).toContain("balanced advertising composition");
  });

  // Схема email mask: item ≤ 25%, персонаж ≥ 75%, центр 25–75% чистый.
  it("admin-configured zones add HARD numeric boundaries to the prompt", () => {
    const p = compositionPrompt("email", {
      hasTemplate: false,
      hasItem: true,
      neuralPrompt: "",
      zones: {
        item: { x: 0, y: 0, w: 0.25, h: 1 },
        person: { x: 0.75, y: 0, w: 0.25, h: 1 },
        protected: { x: 0.25, y: 0, w: 0.5, h: 1 },
      },
    });
    expect(p).toContain("between the left edge and 25% of the canvas width");
    expect(p).toContain("between 75% of the canvas width and the right edge");
    expect(p).toContain("between 25% and 75% of the width");
    expect(p).toContain("PROTECTED CLEAN ZONE");
    // Decor pockets (области декора на схеме): only tiny soft-focus particles
    // near the band's edges, never in the middle.
    expect(p).toContain("only near its very top and bottom edges");
  });

  it("no zones configured → no HARD BOUNDARY lines (push/popup unchanged)", () => {
    const p = compositionPrompt("push", { hasTemplate: false, hasItem: true, neuralPrompt: "" });
    expect(p).not.toContain("HARD BOUNDARY");
    expect(p).not.toContain("PROTECTED CLEAN ZONE");
  });
});

/** BE Test — ITEM source resolution (D12): brand template → bundle_default → built-in. */
describe("buildBundleItemPrompt", () => {
  it("prefers the brand's own ITEM template", async () => {
    db.promptTemplate.findFirst.mockResolvedValueOnce({ content: "Brand items: {{prompt}}" });
    expect(await buildBundleItemPrompt("Betnella(Men)", "reload")).toBe("Brand items: reload");
  });

  it("falls back to the admin-seeded bundle_default preset", async () => {
    db.promptTemplate.findFirst
      .mockResolvedValueOnce(null) // brand key miss
      .mockResolvedValueOnce({ content: "Default anchor: {{prompt}}" });
    expect(await buildBundleItemPrompt("Corgi", "reload")).toBe("Default anchor: reload");
  });

  it("falls back to the built-in prompt when nothing is seeded", async () => {
    db.promptTemplate.findFirst.mockResolvedValue(null);
    const p = await buildBundleItemPrompt("Corgi", "reload");
    expect(p).toContain("golden lucky seven symbols");
    expect(p).toContain("Theme: reload");
  });
});

describe("processPrepareVariantJob (stage A)", () => {
  const variantRow = {
    id: "v1",
    bundleId: "bun1",
    brandName: "Betnella(Men)",
    bundle: {
      id: "bun1",
      neuralPrompt: "Weekend reload",
      bundleType: {
        assets: [
          { key: "email", label: "Email", width: 1200, height: 600 },
          { key: "popup", label: "Pop-up", width: 800, height: 600 },
          { key: "push", label: "Push", width: 1024, height: 512 },
        ],
      },
    },
  };

  it("generates person + item, stores artifacts and fans out stage B", async () => {
    db.bundleBrandVariant.findUnique.mockResolvedValue(variantRow);
    db.brand.findUnique.mockResolvedValue({
      imageModel: null,
      nanoRef: { referenceImages: ["https://cdn/ref1.png"] },
    });
    db.promptTemplate.findFirst.mockResolvedValue(null); // built-in item prompt
    fal.runPersonFal
      .mockResolvedValueOnce({ success: true, imageUrl: "https://fal/person.png" })
      .mockResolvedValueOnce({ success: true, imageUrl: "https://fal/item.png" });
    cloud.uploadFromUrl
      .mockResolvedValueOnce({ success: true, secure_url: "https://cdn/person.png" })
      .mockResolvedValueOnce({ success: true, secure_url: "https://cdn/item.png" });
    db.bundleAsset.findMany.mockResolvedValue([{ id: "a1" }, { id: "a2" }, { id: "a3" }]);
    queue.addBulk.mockResolvedValue([]);

    await processPrepareVariantJob("bun1", "v1");

    // Person uses the brand refs; item generates from scratch (1:1).
    expect(fal.runPersonFal.mock.calls[0]![1]).toEqual(["https://cdn/ref1.png"]);
    expect(fal.runPersonFal.mock.calls[0]![2]).toBe("3:4");
    expect(fal.runPersonFal.mock.calls[1]![1]).toEqual([]);
    expect(fal.runPersonFal.mock.calls[1]![2]).toBe("1:1");
    expect(db.bundleBrandVariant.update).toHaveBeenCalledWith({
      where: { id: "v1" },
      data: {
        personImageUrl: "https://cdn/person.png",
        itemImageUrl: "https://cdn/item.png",
        // No layered assets in the type → no cutouts are produced.
        personCutoutId: null,
        itemCutoutId: null,
        personLayerHash: null,
        itemLayerHash: null,
      },
    });
    expect(layerCache.getOrCreateNormalizedLayer).not.toHaveBeenCalled();
    const jobs = queue.addBulk.mock.calls[0]![0] as Array<{ name: string; data: { assetId: string } }>;
    expect(jobs.map((j) => j.data.assetId)).toEqual(["a1", "a2", "a3"]);
    expect(jobs.every((j) => j.name === "render-asset")).toBe(true);
  });

  it("produces normalized cached layers when the type has a layered asset (Phase 2)", async () => {
    db.bundleBrandVariant.findUnique.mockResolvedValue({
      ...variantRow,
      bundle: {
        ...variantRow.bundle,
        bundleType: {
          assets: [{ key: "email", label: "Email", width: 1200, height: 600, composeMode: "layered" }],
        },
      },
    });
    db.brand.findUnique.mockResolvedValue({ imageModel: null, nanoRef: null });
    db.promptTemplate.findFirst.mockResolvedValue(null);
    fal.runPersonFal
      .mockResolvedValueOnce({ success: true, imageUrl: "https://fal/person.png" })
      .mockResolvedValueOnce({ success: true, imageUrl: "https://fal/item.png" });
    cloud.uploadFromUrl
      .mockResolvedValueOnce({ success: true, secure_url: "https://cdn/person.png", public_id: "b/person" })
      .mockResolvedValueOnce({ success: true, secure_url: "https://cdn/item.png", public_id: "b/item" });
    layerCache.getOrCreateNormalizedLayer
      .mockResolvedValueOnce({
        ok: true,
        hash: "hashP",
        publicId: "layers/layer_p",
        url: "https://cdn/layers/p.png",
        width: 900,
        height: 1400,
        cached: false,
      })
      .mockResolvedValueOnce({
        ok: true,
        hash: "hashI",
        publicId: "layers/layer_i",
        url: "https://cdn/layers/i.png",
        width: 800,
        height: 800,
        cached: true,
      });
    db.bundleAsset.findMany.mockResolvedValue([{ id: "a1" }]);
    queue.addBulk.mockResolvedValue([]);

    await processPrepareVariantJob("bun1", "v1");

    // Layers are normalized from the STORED person/item images.
    expect(layerCache.getOrCreateNormalizedLayer.mock.calls.map((c) => c[0])).toEqual([
      "https://cdn/person.png",
      "https://cdn/item.png",
    ]);
    expect(db.bundleBrandVariant.update).toHaveBeenCalledWith({
      where: { id: "v1" },
      data: {
        personImageUrl: "https://cdn/person.png",
        itemImageUrl: "https://cdn/item.png",
        personCutoutId: "layers/layer_p",
        itemCutoutId: "layers/layer_i",
        personLayerHash: "hashP",
        itemLayerHash: "hashI",
      },
    });
  });

  it("normalization rejects the cutout on every bounded attempt → variant FAILED with the reason", async () => {
    db.bundleBrandVariant.findUnique.mockResolvedValue({
      ...variantRow,
      bundle: {
        ...variantRow.bundle,
        bundleType: {
          assets: [{ key: "email", label: "Email", width: 1200, height: 600, composeMode: "layered" }],
        },
      },
    });
    db.brand.findUnique.mockResolvedValue({ imageModel: null, nanoRef: null });
    db.promptTemplate.findFirst.mockResolvedValue(null);
    // person, item, person-retry (Phase 4 auto-retry of the broken layer).
    fal.runPersonFal.mockResolvedValue({ success: true, imageUrl: "https://fal/gen.png" });
    cloud.uploadFromUrl.mockResolvedValue({ success: true, secure_url: "https://cdn/gen.png" });
    layerCache.getOrCreateNormalizedLayer.mockResolvedValue({
      ok: false,
      reason: "empty layer: no subject pixels after alpha cleanup",
    });

    await processPrepareVariantJob("bun1", "v1");

    expect(db.bundleAsset.updateMany).toHaveBeenCalledWith({
      where: { variantId: "v1", status: { in: ["PENDING", "GENERATING"] } },
      data: {
        status: "FAILED",
        errorMessage: expect.stringContaining("empty layer: no subject pixels"),
      },
    });
    expect(queue.addBulk).not.toHaveBeenCalled();
  });

  it("marks the variant's pending assets FAILED when the person generation fails", async () => {
    db.bundleBrandVariant.findUnique.mockResolvedValue(variantRow);
    db.brand.findUnique.mockResolvedValue({ imageModel: null, nanoRef: null });
    fal.runPersonFal.mockResolvedValueOnce({ success: false, error: "content policy" });

    await processPrepareVariantJob("bun1", "v1");

    expect(db.bundleAsset.updateMany).toHaveBeenCalledWith({
      where: { variantId: "v1", status: { in: ["PENDING", "GENERATING"] } },
      data: { status: "FAILED", errorMessage: "person: content policy" },
    });
    expect(recompute).toHaveBeenCalledWith("bun1");
    expect(queue.addBulk).not.toHaveBeenCalled();
  });

  it("no-ops when the variant is gone (bundle deleted mid-flight)", async () => {
    db.bundleBrandVariant.findUnique.mockResolvedValue(null);
    await processPrepareVariantJob("bun1", "v1");
    expect(fal.runPersonFal).not.toHaveBeenCalled();
  });
});

describe("processRenderAssetJob (stage B)", () => {
  const assetRow = {
    id: "a1",
    bundleId: "bun1",
    variantId: "v1",
    assetKey: "email",
    width: 1200,
    height: 600,
    variant: {
      id: "v1",
      brandName: "Betnella(Men)",
      personImageUrl: "https://cdn/person.png",
      itemImageUrl: "https://cdn/item.png",
      bundle: {
        id: "bun1",
        neuralPrompt: "Weekend reload",
        bundleType: {
          assets: [{ key: "email", label: "Email", width: 1200, height: 600 }],
        },
      },
    },
  };

  it("composes, bleed-expands, center-crops to the exact canvas and stores (D5/D10)", async () => {
    db.bundleAsset.findUnique.mockResolvedValue(assetRow);
    fal.runPersonFal.mockResolvedValue({ success: true, imageUrl: "https://fal/composed.png" });
    imageSize.probeImageSize
      .mockResolvedValueOnce({ width: 1024, height: 576 }) // generated 16:9
      .mockResolvedValueOnce({ width: 1200, height: 600 }); // stored asset
    fal.runBriaExpand.mockResolvedValue({ success: true, imageUrl: "https://fal/expanded.png" });
    cloud.uploadFromUrlTransformed.mockResolvedValue({ success: true, secure_url: "https://cdn/email.png" });

    await processRenderAssetJob("bun1", "v1", "a1");

    // Composition refs: person + item (no template configured yet, R9).
    expect(fal.runPersonFal.mock.calls[0]![1]).toEqual(["https://cdn/person.png", "https://cdn/item.png"]);
    // Expand happens on a 32px-bled canvas with a continuation prompt…
    expect(fal.runBriaExpand).toHaveBeenCalledWith(
      "https://fal/composed.png",
      expect.objectContaining({
        canvasW: 1264,
        canvasH: 664,
        imgW: 1067,
        imgH: 600,
        originX: 99,
        originY: 32,
        prompt: expect.stringContaining("Seamlessly continue"),
      }),
    );
    // …and the upload center-crops back to the exact mask canvas.
    expect(cloud.uploadFromUrlTransformed).toHaveBeenCalledWith(
      "https://fal/expanded.png",
      expect.any(String),
      "bundles/bun1",
      "c_crop,g_center,w_1200,h_600",
    );
    expect(db.bundleAsset.update).toHaveBeenLastCalledWith({
      where: { id: "a1" },
      data: { status: "DONE", imageUrl: "https://cdn/email.png", errorMessage: null },
    });
    expect(recompute).toHaveBeenCalledWith("bun1");
  });

  it("skips the expand when the generated size already matches the canvas", async () => {
    db.bundleAsset.findUnique.mockResolvedValue(assetRow);
    fal.runPersonFal.mockResolvedValue({ success: true, imageUrl: "https://fal/composed.png" });
    imageSize.probeImageSize.mockResolvedValue({ width: 1200, height: 600 });
    cloud.uploadFromUrl.mockResolvedValue({ success: true, secure_url: "https://cdn/email.png" });

    await processRenderAssetJob("bun1", "v1", "a1");
    expect(fal.runBriaExpand).not.toHaveBeenCalled();
    expect(db.bundleAsset.update).toHaveBeenLastCalledWith({
      where: { id: "a1" },
      data: { status: "DONE", imageUrl: "https://cdn/email.png", errorMessage: null },
    });
  });

  it("same-aspect render (popup 4:3) is resized via Cloudinary, no Bria call", async () => {
    db.bundleAsset.findUnique.mockResolvedValue({
      ...assetRow,
      assetKey: "popup",
      width: 800,
      height: 600,
      variant: {
        ...assetRow.variant,
        bundle: {
          ...assetRow.variant.bundle,
          bundleType: { assets: [{ key: "popup", label: "Pop-up", width: 800, height: 600 }] },
        },
      },
    });
    fal.runPersonFal.mockResolvedValue({ success: true, imageUrl: "https://fal/composed.png" });
    imageSize.probeImageSize
      .mockResolvedValueOnce({ width: 1024, height: 768 }) // generated 4:3
      .mockResolvedValueOnce({ width: 800, height: 600 });
    cloud.uploadFromUrlTransformed.mockResolvedValue({ success: true, secure_url: "https://cdn/popup.png" });

    await processRenderAssetJob("bun1", "v1", "a1");
    expect(fal.runBriaExpand).not.toHaveBeenCalled();
    expect(cloud.uploadFromUrlTransformed).toHaveBeenCalledWith(
      "https://fal/composed.png",
      expect.any(String),
      "bundles/bun1",
      "c_fill,w_800,h_600",
    );
  });

  it("fails the asset with a reason when the compose call fails", async () => {
    db.bundleAsset.findUnique.mockResolvedValue(assetRow);
    fal.runPersonFal.mockResolvedValue({ success: false, error: "422" });

    await processRenderAssetJob("bun1", "v1", "a1");
    expect(db.bundleAsset.update).toHaveBeenLastCalledWith({
      where: { id: "a1" },
      data: { status: "FAILED", errorMessage: "compose: 422" },
    });
    expect(recompute).toHaveBeenCalledWith("bun1");
  });

  it("fails fast when the variant has no person artifact", async () => {
    db.bundleAsset.findUnique.mockResolvedValue({
      ...assetRow,
      variant: { ...assetRow.variant, personImageUrl: null },
    });
    await processRenderAssetJob("bun1", "v1", "a1");
    expect(fal.runPersonFal).not.toHaveBeenCalled();
    expect(db.bundleAsset.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { status: "FAILED", errorMessage: "missing person artifact — regenerate the bundle" },
    });
  });
});

/**
 * BE Test — layered compose math (D10 v2): zone fractions → pixel fit-boxes.
 * Item is centered against the left edge of its section, person is anchored
 * bottom-right; 8px pad keeps cutouts off the section lines.
 */
describe("computeLayerPlacements / backgroundPrompt", () => {
  it("maps the email mask zones (25/50/25) to layer boxes on a 1200×600 canvas", () => {
    const p = computeLayerPlacements(
      {
        item: { x: 0, y: 0, w: 0.25, h: 1 },
        person: { x: 0.75, y: 0, w: 0.25, h: 1 },
        protected: { x: 0.25, y: 0, w: 0.5, h: 1 },
      },
      1200,
      600,
    );
    expect(p.item).toEqual({ w: 284, h: 584, gravity: "west", x: 8, y: 0 });
    expect(p.person).toEqual({ w: 284, h: 584, gravity: "south_east", x: 8, y: 0 });
  });

  it("falls back to the default 25/75 sections when zones are missing", () => {
    const p = computeLayerPlacements(undefined, 1200, 600);
    expect(p.item.w).toBe(284);
    expect(p.person.gravity).toBe("south_east");
  });

  it("background prompt = почти пустая светлая студия (эталон example email)", () => {
    const p = backgroundPrompt("Weekend reload");
    expect(p).toContain("NO objects, NO characters, NO symbols, NO text");
    expect(p).toContain("very light neutral gray");
    expect(p).toContain("NO dark or saturated colors");
    expect(p).toContain("Weekend reload");
    expect(p).toContain("FULL-BLEED");
  });
});

describe("processRenderAssetJob — layered mode (D10 v2)", () => {
  const layeredRow = {
    id: "a1",
    bundleId: "bun1",
    variantId: "v1",
    assetKey: "email",
    width: 1200,
    height: 600,
    variant: {
      id: "v1",
      brandName: "Betnella(Men)",
      personImageUrl: "https://cdn/person.png",
      itemImageUrl: "https://cdn/item.png",
      personCutoutId: "b/cut_person",
      itemCutoutId: "b/cut_item",
      bundle: {
        id: "bun1",
        neuralPrompt: "Weekend reload",
        bundleType: {
          assets: [
            {
              key: "email",
              label: "Email",
              width: 1200,
              height: 600,
              composeMode: "layered",
              zones: {
                item: { x: 0, y: 0, w: 0.25, h: 1 },
                person: { x: 0.75, y: 0, w: 0.25, h: 1 },
              },
            },
          ],
        },
      },
    },
  };

  it("generates a background layer and composites the cutouts into their zones", async () => {
    db.bundleAsset.findUnique.mockResolvedValue(layeredRow);
    // Background generation (no template configured).
    fal.runPersonFal.mockResolvedValue({ success: true, imageUrl: "https://fal/bg.png" });
    fal.runBriaExpand.mockResolvedValue({ success: true, imageUrl: "https://fal/bg_expanded.png" });
    imageSize.probeImageSize
      .mockResolvedValueOnce({ width: 1024, height: 576 }) // bg gen
      .mockResolvedValueOnce({ width: 1200, height: 600 }) // stored bg
      .mockResolvedValueOnce({ width: 1200, height: 600 }); // final composed
    cloud.uploadFromUrlTransformed.mockResolvedValue({
      success: true,
      secure_url: "https://cdn/bg.png",
      public_id: "bundles/bun1/bg",
    });
    cloud.uploadFromUrl.mockResolvedValue({
      success: true,
      secure_url: "https://cdn/final_email.png",
      public_id: "bundles/bun1/final",
    });

    await processRenderAssetJob("bun1", "v1", "a1");

    // The backdrop prompt is the layers-only one (no composition directives).
    expect(fal.runPersonFal.mock.calls[0]![0]).toContain("NO objects, NO characters");
    // Compose references the background + both cutouts with zone boxes.
    expect(cloud.composeLayersUrl).toHaveBeenCalledWith("bundles/bun1/bg", [
      { publicId: "b/cut_item", w: 284, h: 584, gravity: "west", x: 8, y: 0 },
      { publicId: "b/cut_person", w: 284, h: 584, gravity: "south_east", x: 8, y: 0 },
    ]);
    // The flattened composed URL is what gets stored as the asset.
    expect(cloud.uploadFromUrl).toHaveBeenCalledWith(
      "https://res.cloudinary/composed.png",
      expect.any(String),
      "bundles/bun1",
    );
    expect(db.bundleAsset.update).toHaveBeenLastCalledWith({
      where: { id: "a1" },
      data: { status: "DONE", imageUrl: "https://cdn/final_email.png", errorMessage: null },
    });
  });

  it("uses the admin template as the background layer when configured", async () => {
    db.bundleAsset.findUnique.mockResolvedValue({
      ...layeredRow,
      variant: {
        ...layeredRow.variant,
        bundle: {
          ...layeredRow.variant.bundle,
          bundleType: {
            assets: [
              {
                key: "email",
                label: "Email",
                width: 1200,
                height: 600,
                composeMode: "layered",
                templateUrl: "https://cdn/template.png",
              },
            ],
          },
        },
      },
    });
    imageSize.probeImageSize.mockResolvedValue({ width: 1200, height: 600 });
    cloud.uploadFromUrlTransformed.mockResolvedValue({
      success: true,
      secure_url: "https://cdn/bg.png",
      public_id: "bundles/bun1/bg",
    });
    cloud.uploadFromUrl.mockResolvedValue({
      success: true,
      secure_url: "https://cdn/final.png",
      public_id: "f",
    });

    await processRenderAssetJob("bun1", "v1", "a1");
    // No background generation happens — the template IS the backdrop.
    expect(fal.runPersonFal).not.toHaveBeenCalled();
    expect(cloud.uploadFromUrlTransformed).toHaveBeenCalledWith(
      "https://cdn/template.png",
      expect.any(String),
      "bundles/bun1",
      "c_fill,w_1200,h_600",
    );
  });

  it("fails fast when the person cutout is missing", async () => {
    db.bundleAsset.findUnique.mockResolvedValue({
      ...layeredRow,
      variant: { ...layeredRow.variant, personCutoutId: null },
    });
    await processRenderAssetJob("bun1", "v1", "a1");
    expect(fal.runPersonFal).not.toHaveBeenCalled();
    expect(db.bundleAsset.update).toHaveBeenLastCalledWith({
      where: { id: "a1" },
      data: { status: "FAILED", errorMessage: "missing person cutout — regenerate the bundle" },
    });
  });
});

describe("processEditAssetJob (D9)", () => {
  const editRow = {
    id: "a1",
    bundleId: "bun1",
    variantId: "v1",
    assetKey: "email",
    width: 1200,
    height: 600,
    imageUrl: "https://cdn/email.png",
    variant: {
      id: "v1",
      brandName: "Betnella(Men)",
      // Режим сборки формата (правка 2026-08-17): от него зависит контракт
      // фона в промпте правки. Здесь движковый рендер — прежний full-bleed.
      bundle: { bundleType: { assets: [{ key: "email", label: "Email" }] } },
    },
  };

  it("edits img2img from the CURRENT image and preserves the canvas size", async () => {
    db.bundleAsset.findUnique.mockResolvedValue(editRow);
    fal.runPersonFal.mockResolvedValue({ success: true, imageUrl: "https://fal/edited.png" });
    imageSize.probeImageSize.mockResolvedValue({ width: 1200, height: 600 }); // no drift
    cloud.uploadFromUrl.mockResolvedValue({ success: true, secure_url: "https://cdn/edited.png" });

    await processEditAssetJob("bun1", "v1", "a1", "warmer background");

    // Source = the current asset image; the user's text is inside the prompt.
    expect(fal.runPersonFal.mock.calls[0]![1]).toEqual(["https://cdn/email.png"]);
    expect(fal.runPersonFal.mock.calls[0]![0]).toContain("warmer background");
    expect(fal.runBriaExpand).not.toHaveBeenCalled();
    expect(db.bundleAsset.update).toHaveBeenLastCalledWith({
      where: { id: "a1" },
      data: { status: "DONE", imageUrl: "https://cdn/edited.png", errorMessage: null },
    });
    expect(recompute).toHaveBeenCalledWith("bun1");
  });

  /**
   * Правка 2026-08-17 (заказчик: «нажимаю Edit — оно меняет фон»). Промпт
   * правки безусловно требовал «full-bleed: фон на весь канвас», хотя у
   * ai_reference контракт обратный — вырезанная композиция на чисто-белом.
   * Любая правка заливала белое сплошной картинкой, и ассет переставал
   * годиться для наложения.
   */
  it("ai_reference: правка сохраняет белый фон, а не заливает его сценой", async () => {
    db.bundleAsset.findUnique.mockResolvedValue({
      ...editRow,
      variant: {
        ...editRow.variant,
        bundle: {
          bundleType: {
            assets: [{ key: "email", label: "Email", composeMode: "ai_reference" }],
          },
        },
      },
    });
    fal.runPersonFal.mockResolvedValue({ success: true, imageUrl: "https://fal/edited.png" });
    imageSize.probeImageSize.mockResolvedValue({ width: 1200, height: 600 });
    cloud.uploadFromUrl.mockResolvedValue({ success: true, secure_url: "https://cdn/edited.png" });

    await processEditAssetJob("bun1", "v1", "a1", "поменяй цвет платья");

    const prompt = fal.runPersonFal.mock.calls[0]![0] as string;
    expect(prompt).toContain("поменяй цвет платья");
    expect(prompt).toContain("pure solid white");
    expect(prompt).toContain("cut out from the white later");
    expect(prompt).not.toContain("Full-bleed");
  });

  it("движковый рендер: прежний full-bleed сохраняется", async () => {
    db.bundleAsset.findUnique.mockResolvedValue(editRow);
    fal.runPersonFal.mockResolvedValue({ success: true, imageUrl: "https://fal/edited.png" });
    imageSize.probeImageSize.mockResolvedValue({ width: 1200, height: 600 });
    cloud.uploadFromUrl.mockResolvedValue({ success: true, secure_url: "https://cdn/edited.png" });

    await processEditAssetJob("bun1", "v1", "a1", "x");
    expect(fal.runPersonFal.mock.calls[0]![0]).toContain("Full-bleed");
  });

  it("re-expands (with bleed) to the canvas when the edit drifts the size", async () => {
    db.bundleAsset.findUnique.mockResolvedValue(editRow);
    fal.runPersonFal.mockResolvedValue({ success: true, imageUrl: "https://fal/edited.png" });
    imageSize.probeImageSize
      .mockResolvedValueOnce({ width: 1024, height: 576 })
      .mockResolvedValueOnce({ width: 1200, height: 600 });
    fal.runBriaExpand.mockResolvedValue({ success: true, imageUrl: "https://fal/expanded.png" });
    cloud.uploadFromUrlTransformed.mockResolvedValue({ success: true, secure_url: "https://cdn/edited.png" });

    await processEditAssetJob("bun1", "v1", "a1", "x");
    expect(fal.runBriaExpand).toHaveBeenCalledWith(
      "https://fal/edited.png",
      expect.objectContaining({ canvasW: 1264, canvasH: 664 }),
    );
    expect(cloud.uploadFromUrlTransformed).toHaveBeenCalledWith(
      "https://fal/expanded.png",
      expect.any(String),
      "bundles/bun1",
      "c_crop,g_center,w_1200,h_600",
    );
  });

  it("fails when the asset has no source image", async () => {
    db.bundleAsset.findUnique.mockResolvedValue({ ...editRow, imageUrl: null });
    await processEditAssetJob("bun1", "v1", "a1", "x");
    expect(fal.runPersonFal).not.toHaveBeenCalled();
    expect(db.bundleAsset.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { status: "FAILED", errorMessage: "edit: no source image" },
    });
  });
});

/**
 * BE Test — engine render path (Phase 3): spec + normalized layers → sharp
 * composite. The engine itself is unit-tested in composeEngine.test.ts; here
 * we verify orchestration, gating and fallbacks.
 */
describe("processRenderAssetJob — engine path (Phase 3)", () => {
  const engineAsset = {
    id: "a1",
    bundleId: "bun1",
    variantId: "v1",
    assetKey: "email",
    width: 1200,
    height: 600,
    variant: {
      id: "v1",
      brandName: "Betnella(Men)",
      personImageUrl: "https://cdn/person.png",
      itemImageUrl: "https://cdn/item.png",
      personCutoutId: "layers/layer_p",
      itemCutoutId: "layers/layer_i",
      personLayerHash: "hp",
      itemLayerHash: "hi",
      bundle: {
        id: "bun1",
        neuralPrompt: "Weekend reload",
        bundleType: {
          assets: [
            {
              key: "email",
              label: "Email",
              width: 1200,
              height: 600,
              composeMode: "layered",
              templateUrl: "https://cdn/bg.png",
            },
          ],
        },
      },
    },
  };
  const specRow = { id: "ls1", key: "email.hero", version: 1, spec: EMAIL_HERO_V1, isActive: true };

  it("renders via the engine: layers by hash, deterministic ids, metadata stored, no AI calls", async () => {
    db.bundleAsset.findUnique.mockResolvedValue(engineAsset);
    db.layoutSpec.findFirst.mockResolvedValue(specRow);
    db.normalizedLayer.findUnique
      .mockResolvedValueOnce({ url: "https://cdn/layers/p.png", width: 900, height: 1400 })
      .mockResolvedValueOnce({ url: "https://cdn/layers/i.png", width: 800, height: 800 });
    layerCache.fetchBuffer.mockResolvedValue(Buffer.from("img"));
    engine.composeAsset.mockResolvedValue({
      ok: true,
      scales: [
        { scale: 1, width: 1200, height: 600, png: Buffer.from("1x") },
        { scale: 2, width: 2400, height: 1200, png: Buffer.from("2x") },
      ],
      metadata: {
        specKey: "email.hero",
        specVersion: 1,
        luminance: 0.8,
        recommendedTextColor: "#111111",
        layers: { person: { x: 840, y: 72, w: 309, h: 480 }, item: null, decorPlaced: 0, decorSkipped: 0 },
      },
    });
    cloud.uploadBuffer.mockResolvedValue({
      success: true,
      secure_url: "https://res.cloudinary.com/demo/image/upload/v1/bundles/bun1/v1_email_v1.png",
    });

    await processRenderAssetJob("bun1", "v1", "a1");

    // Seed is derived from asset + spec version + layer hashes (determinism).
    expect(engine.composeAsset.mock.calls[0]![4]).toBe("a1:v1:hp:hi");
    // Only the canonical scale is rendered — no `_2x` twin anywhere (D-E7).
    expect(engine.composeAsset.mock.calls[0]![0].canvas.scales).toEqual([1]);
    expect(cloud.uploadBuffer).toHaveBeenCalledTimes(1);
    expect(cloud.uploadBuffer.mock.calls[0]![1]).toBe("v1_email_v1");
    expect(cloud.uploadBuffer.mock.calls[0]![2]).toBe("bundles/bun1");
    expect(db.bundleAsset.update).toHaveBeenLastCalledWith({
      where: { id: "a1" },
      data: {
        status: "DONE",
        imageUrl: "https://res.cloudinary.com/demo/image/upload/v1/bundles/bun1/v1_email_v1.png",
        metadata: expect.objectContaining({
          retinaUrl: null,
          specVersion: 1,
          recommendedTextColor: "#111111",
        }),
        errorMessage: null,
      },
    });
    // Никаких AI-вызовов и Cloudinary-overlay в движковом пути (DI-Q6, D-E4).
    expect(fal.runPersonFal).not.toHaveBeenCalled();
    expect(cloud.composeLayersUrl).not.toHaveBeenCalled();
  });

  it("флаг scenePipeline в активной спеке уводит рендер в scene-пайплайн (Фаза 6)", async () => {
    db.bundleAsset.findUnique.mockResolvedValue(engineAsset);
    db.layoutSpec.findFirst.mockResolvedValue({
      ...specRow,
      spec: { ...EMAIL_HERO_V1, scenePipeline: true },
    });
    db.brand.findUnique.mockResolvedValue({
      id: "br1",
      decorUrls: [{ url: "https://cdn/decor/a.png", concepts: ["coin"] }],
    });
    scenePipeline.renderSceneAsset.mockResolvedValue({
      ok: true,
      imageUrl: "https://cdn/scene.png",
      metadata: { scenePipeline: true },
    });

    await processRenderAssetJob("bun1", "v1", "a1");

    expect(scenePipeline.renderSceneAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        bundleId: "bun1",
        variantId: "v1",
        assetId: "a1",
        assetKey: "email",
        brandName: "Betnella(Men)",
        brandId: "br1",
        campaignPrompt: "Weekend reload",
        personLayerHash: "hp",
        itemLayerHash: "hi",
        canvas: { w: 1200, h: 600 },
        // Сырые Json-колонки — тегированные записи доходят до пайплайна,
        // а не режутся до строк по дороге (D-N9').
        brandDecorRaw: [{ url: "https://cdn/decor/a.png", concepts: ["coin"] }],
      }),
    );
    // Старый движок не вызывается — подмена этапа, а не дублирование.
    expect(engine.composeAsset).not.toHaveBeenCalled();
    expect(db.bundleAsset.update).toHaveBeenLastCalledWith({
      where: { id: "a1" },
      data: expect.objectContaining({ status: "DONE", imageUrl: "https://cdn/scene.png" }),
    });
  });

  it("провал scene-пайплайна кладёт отчёт валидатора в метаданные FAILED-ассета", async () => {
    db.bundleAsset.findUnique.mockResolvedValue(engineAsset);
    db.layoutSpec.findFirst.mockResolvedValue({
      ...specRow,
      spec: { ...EMAIL_HERO_V1, scenePipeline: true },
    });
    db.brand.findUnique.mockResolvedValue({ id: "br1", decorUrls: null });
    scenePipeline.renderSceneAsset.mockResolvedValue({
      ok: false,
      reason: "scene validation failed — decorCount: 2 при требовании ≥ 6.65",
      metadata: { scenePipeline: true, validator: { passed: false } },
    });

    await processRenderAssetJob("bun1", "v1", "a1");

    expect(db.bundleAsset.update).toHaveBeenLastCalledWith({
      where: { id: "a1" },
      data: expect.objectContaining({
        status: "FAILED",
        errorMessage: expect.stringContaining("decorCount"),
        metadata: expect.objectContaining({ scenePipeline: true }),
      }),
    });
  });

  it("fails readable when the static background template is missing (DI-Q6)", async () => {
    const noTemplate = structuredClone(engineAsset);
    delete (noTemplate.variant.bundle.bundleType.assets[0] as Record<string, unknown>).templateUrl;
    db.bundleAsset.findUnique.mockResolvedValue(noTemplate);
    db.layoutSpec.findFirst.mockResolvedValue(specRow);

    await processRenderAssetJob("bun1", "v1", "a1");

    expect(engine.composeAsset).not.toHaveBeenCalled();
    expect(db.bundleAsset.update).toHaveBeenLastCalledWith({
      where: { id: "a1" },
      // The reason names the spec version that demands the background, so the
      // admin can see WHY a template is suddenly required.
      data: {
        status: "FAILED",
        errorMessage: expect.stringContaining("email.hero@v1 requires a static background"),
      },
    });
    // Фон НЕ генерится нейросетью даже при отсутствии шаблона (DI-Q6).
    expect(fal.runPersonFal).not.toHaveBeenCalled();
  });

  it("transparent spec renders without any background template at all", async () => {
    const noTemplate = structuredClone(engineAsset);
    delete (noTemplate.variant.bundle.bundleType.assets[0] as Record<string, unknown>).templateUrl;
    db.bundleAsset.findUnique.mockResolvedValue(noTemplate);
    db.layoutSpec.findFirst.mockResolvedValue({ ...specRow, version: 2, spec: EMAIL_HERO_V2 });
    db.normalizedLayer.findUnique
      .mockResolvedValueOnce({ url: "https://cdn/layers/p.png", width: 900, height: 1400 })
      .mockResolvedValueOnce({ url: "https://cdn/layers/i.png", width: 800, height: 800 });
    layerCache.fetchBuffer.mockResolvedValue(Buffer.from("img"));
    engine.composeAsset.mockResolvedValue({
      ok: true,
      scales: [
        { scale: 1, width: 1200, height: 600, png: Buffer.from("1x") },
        { scale: 2, width: 2400, height: 1200, png: Buffer.from("2x") },
      ],
      metadata: {
        specKey: "email.hero",
        specVersion: 2,
        luminance: null,
        recommendedTextColor: null,
        layers: { person: { x: 840, y: 72, w: 309, h: 480 }, item: null, decorPlaced: 0, decorSkipped: 0 },
      },
    });
    cloud.uploadBuffer.mockResolvedValue({
      success: true,
      secure_url: "https://res.cloudinary.com/demo/image/upload/v1/b/v1_email_v2.png",
    });

    await processRenderAssetJob("bun1", "v1", "a1");

    // The engine is handed layers only — no background input, none downloaded.
    expect(engine.composeAsset).toHaveBeenCalled();
    expect(engine.composeAsset.mock.calls[0]![3].background).toBeUndefined();
    expect(db.bundleAsset.update).toHaveBeenLastCalledWith({
      where: { id: "a1" },
      data: expect.objectContaining({
        status: "DONE",
        imageUrl: "https://res.cloudinary.com/demo/image/upload/v1/b/v1_email_v2.png",
      }),
    });
  });

  it("falls back to the legacy Cloudinary compose for pre-Phase 2 bundles (no layer hashes)", async () => {
    const legacy = structuredClone(engineAsset);
    (legacy.variant as Record<string, unknown>).personLayerHash = null;
    (legacy.variant as Record<string, unknown>).itemLayerHash = null;
    db.bundleAsset.findUnique.mockResolvedValue(legacy);
    cloud.uploadFromUrlTransformed.mockResolvedValue({ success: true, public_id: "b/bg" });
    cloud.uploadFromUrl.mockResolvedValue({ success: true, secure_url: "https://cdn/composed.png" });
    imageSize.probeImageSize.mockResolvedValue({ width: 1200, height: 600 });

    await processRenderAssetJob("bun1", "v1", "a1");

    expect(engine.composeAsset).not.toHaveBeenCalled();
    expect(db.layoutSpec.findFirst).not.toHaveBeenCalled();
    expect(cloud.composeLayersUrl).toHaveBeenCalled();
    expect(db.bundleAsset.update).toHaveBeenLastCalledWith({
      where: { id: "a1" },
      data: { status: "DONE", imageUrl: "https://cdn/composed.png", errorMessage: null },
    });
  });

  it("fails readable when the asset config canvas contradicts the spec canvas", async () => {
    const wrongCanvas = structuredClone(engineAsset);
    (wrongCanvas.variant.bundle.bundleType.assets[0] as Record<string, unknown>).width = 1024;
    (wrongCanvas.variant.bundle.bundleType.assets[0] as Record<string, unknown>).height = 512;
    db.bundleAsset.findUnique.mockResolvedValue(wrongCanvas);
    db.layoutSpec.findFirst.mockResolvedValue(specRow);

    await processRenderAssetJob("bun1", "v1", "a1");

    expect(engine.composeAsset).not.toHaveBeenCalled();
    expect(db.bundleAsset.update).toHaveBeenLastCalledWith({
      where: { id: "a1" },
      data: { status: "FAILED", errorMessage: expect.stringContaining("canvas mismatch") },
    });
  });

  const okCompose = () => ({
    ok: true,
    scales: [{ scale: 1, width: 1200, height: 600, png: Buffer.from("1x") }],
    overlayMask: Buffer.from("mask"),
    metadata: {
      specKey: "email.hero",
      specVersion: 1,
      layers: { person: { x: 900, y: 72, w: 240, h: 480 }, item: null, decorPlaced: 1, decorSkipped: 0 },
    },
  });

  function armEngineHappyMocks() {
    db.layoutSpec.findFirst.mockResolvedValue(specRow);
    db.normalizedLayer.findUnique
      .mockResolvedValueOnce({ url: "https://cdn/layers/p.png", width: 900, height: 1400 })
      .mockResolvedValueOnce({ url: "https://cdn/layers/i.png", width: 800, height: 800 });
    layerCache.fetchBuffer.mockResolvedValue(Buffer.from("img"));
    cloud.uploadBuffer.mockResolvedValue({ success: true, secure_url: "https://cdn/final.png" });
  }

  it("validation failure (subject/background) → FAILED with the check details + report kept in metadata (Phase 4)", async () => {
    db.bundleAsset.findUnique.mockResolvedValue(engineAsset);
    armEngineHappyMocks();
    engine.composeAsset.mockResolvedValue(okCompose());
    validator.validateComposedAsset.mockResolvedValue({
      passed: false,
      checks: [
        {
          key: "person-scale",
          passed: false,
          detail: "height 318px = 53% of canvas, want 74–86%",
        },
      ],
      failedKeys: ["person-scale"],
    });

    await processRenderAssetJob("bun1", "v1", "a1");

    // Deterministic failure → no re-seed attempts, no upload.
    expect(engine.composeAsset).toHaveBeenCalledTimes(1);
    expect(cloud.uploadBuffer).not.toHaveBeenCalled();
    expect(db.bundleAsset.update).toHaveBeenLastCalledWith({
      where: { id: "a1" },
      data: {
        status: "FAILED",
        errorMessage: expect.stringContaining("person-scale: height 318px"),
        metadata: expect.objectContaining({
          validator: expect.objectContaining({ passed: false, attempts: 1 }),
        }),
      },
    });
  });

  it("decor-layout violation → re-seed and re-compose, bounded (переподбор раскладки)", async () => {
    const withDecor = structuredClone(engineAsset);
    (withDecor.variant.bundle.bundleType.assets[0] as Record<string, unknown>).decorUrls = [
      "https://cdn/decor1.png",
    ];
    db.bundleAsset.findUnique.mockResolvedValue(withDecor);
    armEngineHappyMocks();
    layerCache.getOrCreateNormalizedLayer.mockResolvedValue({
      ok: true, hash: "hd", publicId: "layers/d", url: "https://cdn/layers/d.png", width: 100, height: 100, cached: true,
    });
    engine.composeAsset.mockResolvedValue(okCompose());
    validator.validateComposedAsset
      .mockResolvedValueOnce({
        passed: false,
        checks: [{ key: "safe-core-clean", passed: false, detail: "12 opaque px" }],
        failedKeys: ["safe-core-clean"],
      })
      .mockResolvedValueOnce({ passed: true, checks: [], failedKeys: [] });

    await processRenderAssetJob("bun1", "v1", "a1");

    expect(engine.composeAsset).toHaveBeenCalledTimes(2);
    // Second attempt got the re-seeded suffix.
    expect(engine.composeAsset.mock.calls[1]![4]).toBe("a1:v1:hp:hi:r1");
    expect(db.bundleAsset.update).toHaveBeenLastCalledWith({
      where: { id: "a1" },
      data: expect.objectContaining({
        status: "DONE",
        metadata: expect.objectContaining({
          validator: expect.objectContaining({ passed: true, attempts: 2 }),
        }),
      }),
    });
  });
});

/**
 * BE Test — person layer sanity auto-retry in stage A (Phase 4): a broken
 * cutout is regenerated BEFORE any render, so every asset of the variant
 * keeps using the same person.
 */
describe("processPrepareVariantJob — person layer sanity retry (Phase 4)", () => {
  const layeredVariant = {
    id: "v1",
    bundleId: "bun1",
    brandName: "Betnella(Men)",
    bundle: {
      id: "bun1",
      neuralPrompt: "Weekend reload",
      bundleType: {
        assets: [{ key: "email", label: "Email", width: 1200, height: 600, composeMode: "layered" }],
      },
    },
  };

  it("insane person layer → one regeneration, variant stores the retried artifacts", async () => {
    db.bundleBrandVariant.findUnique.mockResolvedValue(layeredVariant);
    db.brand.findUnique.mockResolvedValue({ imageModel: null, nanoRef: null });
    db.promptTemplate.findFirst.mockResolvedValue(null);
    fal.runPersonFal
      .mockResolvedValueOnce({ success: true, imageUrl: "https://fal/person1.png" }) // person attempt 1
      .mockResolvedValueOnce({ success: true, imageUrl: "https://fal/item.png" }) // item
      .mockResolvedValueOnce({ success: true, imageUrl: "https://fal/person2.png" }); // person retry
    cloud.uploadFromUrl
      .mockResolvedValueOnce({ success: true, secure_url: "https://cdn/person1.png" })
      .mockResolvedValueOnce({ success: true, secure_url: "https://cdn/item.png" })
      .mockResolvedValueOnce({ success: true, secure_url: "https://cdn/person2.png" });
    layerCache.getOrCreateNormalizedLayer
      .mockResolvedValueOnce({
        ok: true, hash: "h-bad", publicId: "layers/bad", url: "u", width: 2000, height: 500, cached: false,
      }) // landscape sliver → insane
      .mockResolvedValueOnce({
        ok: true, hash: "h-good", publicId: "layers/good", url: "u", width: 900, height: 1400, cached: false,
      }) // retried person
      .mockResolvedValueOnce({
        ok: true, hash: "h-item", publicId: "layers/item", url: "u", width: 800, height: 800, cached: false,
      }); // item
    validator.personLayerSanity
      .mockReturnValueOnce({ ok: false, reason: "person layer is landscape-shaped" })
      .mockReturnValueOnce({ ok: true, reason: "" });
    db.bundleAsset.findMany.mockResolvedValue([{ id: "a1" }]);
    queue.addBulk.mockResolvedValue([]);

    await processPrepareVariantJob("bun1", "v1");

    // Person got regenerated once; the variant stores the RETRIED person url +
    // the sane layer hash.
    expect(fal.runPersonFal).toHaveBeenCalledTimes(3);
    expect(db.bundleBrandVariant.update).toHaveBeenCalledWith({
      where: { id: "v1" },
      data: expect.objectContaining({
        personImageUrl: "https://cdn/person2.png",
        personCutoutId: "layers/good",
        personLayerHash: "h-good",
        itemLayerHash: "h-item",
      }),
    });
  });

  it("still insane after the bounded retries → variant FAILED with the reason", async () => {
    db.bundleBrandVariant.findUnique.mockResolvedValue(layeredVariant);
    db.brand.findUnique.mockResolvedValue({ imageModel: null, nanoRef: null });
    db.promptTemplate.findFirst.mockResolvedValue(null);
    fal.runPersonFal.mockResolvedValue({ success: true, imageUrl: "https://fal/person.png" });
    cloud.uploadFromUrl.mockResolvedValue({ success: true, secure_url: "https://cdn/person.png" });
    layerCache.getOrCreateNormalizedLayer.mockResolvedValue({
      ok: true, hash: "h-bad", publicId: "layers/bad", url: "u", width: 2000, height: 500, cached: false,
    });
    validator.personLayerSanity.mockReturnValue({
      ok: false,
      reason: "person layer is landscape-shaped",
    });

    await processPrepareVariantJob("bun1", "v1");

    expect(db.bundleAsset.updateMany).toHaveBeenCalledWith({
      where: { variantId: "v1", status: { in: ["PENDING", "GENERATING"] } },
      data: {
        status: "FAILED",
        errorMessage: expect.stringContaining("person layer is landscape-shaped"),
      },
    });
    expect(queue.addBulk).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Мультиформатное промо (TASK multiformat-promo, DI2-3): единый стиль требует
// порядка — сначала якорь (email), затем push/pop-up на его композиции.
// ---------------------------------------------------------------------------

const AI_REF_ASSETS = [
  { key: "email", label: "Email", width: 1200, height: 600, composeMode: "ai_reference" },
  { key: "popup", label: "Pop-up", width: 800, height: 600, composeMode: "ai_reference" },
  { key: "push", label: "Push", width: 1024, height: 512, composeMode: "ai_reference" },
];

function aiRefAssetRow(assetKey: string, id: string) {
  const config = AI_REF_ASSETS.find((a) => a.key === assetKey)!;
  return {
    id,
    bundleId: "bun1",
    variantId: "v1",
    assetKey,
    width: config.width,
    height: config.height,
    variant: {
      id: "v1",
      brandName: "Betnella(Men)",
      personImageUrl: null,
      itemImageUrl: null,
      bundle: {
        id: "bun1",
        neuralPrompt: "VIP weekend",
        bundleType: { assets: AI_REF_ASSETS },
      },
    },
  };
}

describe("порядок ai_reference: якорь → зависимые (DI2-3)", () => {
  it("prepare-variant ставит в очередь ТОЛЬКО якорь, остальные ждут его", async () => {
    db.bundleBrandVariant.findUnique.mockResolvedValue({
      id: "v1",
      bundleId: "bun1",
      brandName: "Betnella(Men)",
      bundle: { id: "bun1", neuralPrompt: "VIP weekend", bundleType: { assets: AI_REF_ASSETS } },
    });
    db.bundleAsset.findMany.mockResolvedValue([
      { id: "a1", assetKey: "email" },
      { id: "a2", assetKey: "popup" },
      { id: "a3", assetKey: "push" },
    ]);
    queue.addBulk.mockResolvedValue([]);

    await processPrepareVariantJob("bun1", "v1");

    // Person/item для этого режима не генерируются вовсе.
    expect(fal.runPersonFal).not.toHaveBeenCalled();
    const jobs = queue.addBulk.mock.calls[0]![0] as Array<{ data: { assetId: string } }>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data.assetId).toBe("a1");
  });

  it("якорь уже готов (перезапуск зависимых) → они ставятся сразу", async () => {
    db.bundleBrandVariant.findUnique.mockResolvedValue({
      id: "v1",
      bundleId: "bun1",
      brandName: "Betnella(Men)",
      bundle: { id: "bun1", neuralPrompt: "VIP weekend", bundleType: { assets: AI_REF_ASSETS } },
    });
    db.bundleAsset.findMany.mockResolvedValue([
      { id: "a2", assetKey: "popup" },
      { id: "a3", assetKey: "push" },
    ]);
    queue.addBulk.mockResolvedValue([]);

    await processPrepareVariantJob("bun1", "v1");
    const jobs = queue.addBulk.mock.calls[0]![0] as Array<{ data: { assetId: string } }>;
    expect(jobs.map((j) => j.data.assetId)).toEqual(["a2", "a3"]);
  });

  it("успех якоря → зависимые переводятся в GENERATING и уходят в очередь", async () => {
    db.bundleAsset.findUnique.mockResolvedValue(aiRefAssetRow("email", "a1"));
    db.bundleAsset.findMany.mockResolvedValue([{ id: "a2" }, { id: "a3" }]);
    queue.addBulk.mockResolvedValue([]);

    await processRenderAssetJob("bun1", "v1", "a1");

    const [args] = aiRef.processAiReferenceAsset.mock.calls[0]!;
    expect(args.isAnchor).toBe(true);
    expect(args.formatLabel).toBe("Email");
    expect(db.bundleAsset.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["a2", "a3"] } },
      data: { status: "GENERATING", errorMessage: null },
    });
    const jobs = queue.addBulk.mock.calls[0]![0] as Array<{ data: { assetId: string } }>;
    expect(jobs.map((j) => j.data.assetId)).toEqual(["a2", "a3"]);
  });

  it("провал якоря → зависимые FAILED с понятной причиной, очередь не трогаем", async () => {
    aiRef.processAiReferenceAsset.mockResolvedValue({ ok: false });
    db.bundleAsset.findUnique.mockResolvedValue(aiRefAssetRow("email", "a1"));
    db.bundleAsset.findMany.mockResolvedValue([{ id: "a2" }, { id: "a3" }]);

    await processRenderAssetJob("bun1", "v1", "a1");

    expect(db.bundleAsset.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["a2", "a3"] } },
      data: {
        status: "FAILED",
        errorMessage: 'ai_reference: якорный ассет "email" не сгенерирован — перегенерируйте его',
      },
    });
    expect(queue.addBulk).not.toHaveBeenCalled();
  });

  it("зависимый формат получает контекст якоря и не тянет за собой каскад", async () => {
    aiRef.loadAnchorContext.mockResolvedValue({
      imageUrl: "https://cdn/email-base.png",
      styleText: "Palette: neon purple.",
    });
    db.bundleAsset.findUnique.mockResolvedValue(aiRefAssetRow("push", "a3"));

    await processRenderAssetJob("bun1", "v1", "a3");

    expect(aiRef.loadAnchorContext).toHaveBeenCalledWith("v1", "email");
    const [args] = aiRef.processAiReferenceAsset.mock.calls[0]!;
    expect(args.isAnchor).toBe(false);
    expect(args.formatLabel).toBe("Push");
    expect(args.anchor).toEqual({
      imageUrl: "https://cdn/email-base.png",
      styleText: "Palette: neon purple.",
    });
    expect(queue.addBulk).not.toHaveBeenCalled();
  });

  it("якоря нет → зависимый формат FAILED, деньги на генерацию не тратятся", async () => {
    aiRef.loadAnchorContext.mockResolvedValue(null);
    db.bundleAsset.findUnique.mockResolvedValue(aiRefAssetRow("popup", "a2"));

    await processRenderAssetJob("bun1", "v1", "a2");

    expect(aiRef.processAiReferenceAsset).not.toHaveBeenCalled();
    expect(db.bundleAsset.update).toHaveBeenCalledWith({
      where: { id: "a2" },
      data: {
        status: "FAILED",
        errorMessage: 'ai_reference: якорный ассет "email" не сгенерирован — перегенерируйте его',
      },
    });
  });
});
