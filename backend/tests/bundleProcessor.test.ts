import { describe, it, expect, beforeEach, vi } from "vitest";

// Heavy deps are mocked: prisma, fal, cloudinary, image probing, the person
// prompt-writer (redis) and the queue. The pipeline logic itself runs for real.
const db = vi.hoisted(() => ({
  bundleBrandVariant: { findUnique: vi.fn(), update: vi.fn() },
  bundleAsset: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  brand: { findUnique: vi.fn() },
  promptTemplate: { findFirst: vi.fn() },
}));
const fal = vi.hoisted(() => ({
  runPersonFal: vi.fn(),
  runBriaExpand: vi.fn(),
  runBriaRemoveBg: vi.fn(),
}));
const cloud = vi.hoisted(() => ({
  uploadFromUrl: vi.fn(),
  uploadFromUrlTransformed: vi.fn(),
  composeLayersUrl: vi.fn(() => "https://res.cloudinary/composed.png"),
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
      },
    });
    expect(fal.runBriaRemoveBg).not.toHaveBeenCalled();
    const jobs = queue.addBulk.mock.calls[0]![0] as Array<{ name: string; data: { assetId: string } }>;
    expect(jobs.map((j) => j.data.assetId)).toEqual(["a1", "a2", "a3"]);
    expect(jobs.every((j) => j.name === "render-asset")).toBe(true);
  });

  it("produces transparent cutouts when the type has a layered asset (D10 v2)", async () => {
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
    fal.runBriaRemoveBg
      .mockResolvedValueOnce({ success: true, imageUrl: "https://fal/person_cut.png" })
      .mockResolvedValueOnce({ success: true, imageUrl: "https://fal/item_cut.png" });
    cloud.uploadFromUrl
      .mockResolvedValueOnce({ success: true, secure_url: "https://cdn/person.png", public_id: "b/person" })
      .mockResolvedValueOnce({ success: true, secure_url: "https://cdn/item.png", public_id: "b/item" })
      .mockResolvedValueOnce({ success: true, secure_url: "https://cdn/pcut.png", public_id: "b/cut_person" })
      .mockResolvedValueOnce({ success: true, secure_url: "https://cdn/icut.png", public_id: "b/cut_item" });
    db.bundleAsset.findMany.mockResolvedValue([{ id: "a1" }]);
    queue.addBulk.mockResolvedValue([]);

    await processPrepareVariantJob("bun1", "v1");

    // Cutouts are made from the STORED person/item images.
    expect(fal.runBriaRemoveBg.mock.calls.map((c) => c[0])).toEqual([
      "https://cdn/person.png",
      "https://cdn/item.png",
    ]);
    expect(db.bundleBrandVariant.update).toHaveBeenCalledWith({
      where: { id: "v1" },
      data: {
        personImageUrl: "https://cdn/person.png",
        itemImageUrl: "https://cdn/item.png",
        personCutoutId: "b/cut_person",
        itemCutoutId: "b/cut_item",
      },
    });
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

  it("background prompt bans objects/characters/text on the backdrop layer", () => {
    const p = backgroundPrompt("Weekend reload");
    expect(p).toContain("NO objects, NO characters, NO symbols, NO text");
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
