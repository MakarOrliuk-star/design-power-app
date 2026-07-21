import { describe, it, expect, beforeEach, vi } from "vitest";

// Heavy deps are mocked: prisma, fal, cloudinary, image probing, the person
// prompt-writer (redis) and the queue. The pipeline logic itself runs for real.
const db = vi.hoisted(() => ({
  bundleBrandVariant: { findUnique: vi.fn(), update: vi.fn() },
  bundleAsset: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  brand: { findUnique: vi.fn() },
  promptTemplate: { findFirst: vi.fn() },
}));
const fal = vi.hoisted(() => ({ runPersonFal: vi.fn(), runBriaExpand: vi.fn() }));
const cloud = vi.hoisted(() => ({
  uploadFromUrl: vi.fn(),
  uploadFromUrlTransformed: vi.fn(),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));
const imageSize = vi.hoisted(() => ({
  probeImageSize: vi.fn(),
  nearestFalAspect: vi.fn(() => "16:9"),
}));
const queue = vi.hoisted(() => ({ addBulk: vi.fn() }));
const recompute = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/prisma.js", () => ({ prisma: db }));
vi.mock("../src/lib/fal.js", () => fal);
vi.mock("../src/lib/cloudinary.js", () => cloud);
vi.mock("../src/lib/imageSize.js", () => imageSize);
vi.mock("../src/queues/index.js", () => ({ getBundleQueue: () => queue }));
vi.mock("../src/queues/person.processor.js", () => ({
  buildPersonPromptMemoized: vi.fn(async (_b: string, brand: string, text: string) => `PP(${brand}): ${text}`),
}));
vi.mock("../src/services/bundle.service.js", () => ({ recomputeBundleStatus: recompute }));

import {
  buildBundleItemPrompt,
  compositionPrompt,
  computeBleedPlacement,
  computeCanvasPlacement,
  processEditAssetJob,
  processPrepareVariantJob,
  processRenderAssetJob,
} from "../src/queues/bundle.processor.js";

beforeEach(() => {
  for (const delegate of Object.values(db))
    for (const fn of Object.values(delegate)) (fn as ReturnType<typeof vi.fn>).mockReset();
  fal.runPersonFal.mockReset();
  fal.runBriaExpand.mockReset();
  cloud.uploadFromUrl.mockReset();
  cloud.uploadFromUrlTransformed.mockReset();
  imageSize.probeImageSize.mockReset();
  queue.addBulk.mockReset();
  recompute.mockReset();
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
    bundle: { id: "bun1", neuralPrompt: "Weekend reload" },
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
      data: { personImageUrl: "https://cdn/person.png", itemImageUrl: "https://cdn/item.png" },
    });
    const jobs = queue.addBulk.mock.calls[0]![0] as Array<{ name: string; data: { assetId: string } }>;
    expect(jobs.map((j) => j.data.assetId)).toEqual(["a1", "a2", "a3"]);
    expect(jobs.every((j) => j.name === "render-asset")).toBe(true);
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

describe("processEditAssetJob (D9)", () => {
  const editRow = {
    id: "a1",
    bundleId: "bun1",
    variantId: "v1",
    assetKey: "email",
    width: 1200,
    height: 600,
    imageUrl: "https://cdn/email.png",
    variant: { id: "v1", brandName: "Betnella(Men)" },
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
