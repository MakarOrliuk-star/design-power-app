import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import request from "supertest";

// Mutable env state so we can flip the (shared) edit/scale pipeline readiness per
// test. The env module is mocked to avoid its import-time process.exit() validation.
const cfg = vi.hoisted(() => ({ edit: true }));
const db = vi.hoisted(() => ({
  findFirst: vi.fn(), // generation lookup
  update: vi.fn(),
}));
const cloud = vi.hoisted(() => ({ uploadFromUrl: vi.fn(), uploadBase64: vi.fn() }));
const fal = vi.hoisted(() => ({
  runBriaExpand: vi.fn(),
  runSeedvrUpscale: vi.fn(),
  runBriaGenfill: vi.fn(),
  runBriaEraser: vi.fn(),
}));
const img = vi.hoisted(() => ({ probeImageSize: vi.fn() }));
const lang = vi.hoisted(() => ({ ensureEnglishPrompt: vi.fn() }));

vi.mock("../src/env.js", () => ({
  personPipelineReady: true,
  itemPipelineReady: true,
  get editPipelineReady() {
    return cfg.edit;
  },
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { generation: { findFirst: db.findFirst, update: db.update } },
}));
vi.mock("../src/lib/cloudinary.js", () => ({
  uploadBase64: cloud.uploadBase64,
  uploadFromUrl: cloud.uploadFromUrl,
  withRetry: (fn: () => unknown) => fn(), // run the wrapped upload once, no backoff
}));
vi.mock("../src/lib/fal.js", () => ({
  runBriaExpand: fal.runBriaExpand,
  runSeedvrUpscale: fal.runSeedvrUpscale,
  runBriaGenfill: fal.runBriaGenfill,
  runBriaEraser: fal.runBriaEraser,
}));
vi.mock("../src/lib/imageSize.js", () => ({
  probeImageSize: img.probeImageSize,
  probeAspectRatio: vi.fn(),
}));
vi.mock("../src/lib/promptLang.js", () => ({
  ensureEnglishPrompt: lang.ensureEnglishPrompt,
}));
vi.mock("../src/services/finalize.js", () => ({ recomputeBatchStatus: vi.fn() }));
vi.mock("../src/queues/index.js", () => ({
  getPersonQueue: () => ({ addBulk: vi.fn() }),
  getItemQueue: () => ({ addBulk: vi.fn() }),
}));

import { generateRouter } from "../src/routes/generate.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: { sub: string } }).user = { sub: "user1" };
    next();
  });
  app.use("/api", generateRouter);
  return app;
}

const okBody = { generationId: "g1", pad: { top: 100, right: 0, bottom: 0, left: 0 } };

beforeEach(() => {
  cfg.edit = true;
  db.findFirst.mockReset();
  db.update.mockReset();
  cloud.uploadFromUrl.mockReset();
  cloud.uploadBase64.mockReset();
  fal.runBriaExpand.mockReset();
  fal.runSeedvrUpscale.mockReset();
  fal.runBriaGenfill.mockReset();
  fal.runBriaEraser.mockReset();
  img.probeImageSize.mockReset();
  // Default: the ASCII passthrough path (translation is exercised explicitly).
  lang.ensureEnglishPrompt.mockReset();
  lang.ensureEnglishPrompt.mockImplementation(async (p: string) => ({ ok: true, prompt: p.trim() }));
});

/** POST /api/generate/scale guard rails (TASK §1 Scale). */
describe("POST /api/generate/scale — validation", () => {
  it("rejects a malformed pad with 400 invalid_body", async () => {
    const res = await request(makeApp())
      .post("/api/generate/scale")
      .send({ generationId: "g1", pad: { top: "x", right: 0, bottom: 0, left: 0 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(db.findFirst).not.toHaveBeenCalled();
  });

  it("returns 400 no_target when neither pad nor placement is sent", async () => {
    const res = await request(makeApp()).post("/api/generate/scale").send({ generationId: "g1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_target");
    expect(db.findFirst).not.toHaveBeenCalled();
  });

  it("returns 503 when the pipeline is not configured", async () => {
    cfg.edit = false;
    const res = await request(makeApp()).post("/api/generate/scale").send(okBody);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("scale_pipeline_not_configured");
    expect(db.findFirst).not.toHaveBeenCalled();
  });

  it("returns 404 when the source image is not the user's DONE image", async () => {
    db.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).post("/api/generate/scale").send(okBody);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_editable_image");
  });

  it("returns 422 when the source dimensions can't be probed", async () => {
    db.findFirst.mockResolvedValue({ id: "g1", generatedImageUrl: "https://cdn/1.png", brandName: "X" });
    img.probeImageSize.mockResolvedValue(null);
    const res = await request(makeApp()).post("/api/generate/scale").send(okBody);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("probe_failed");
    expect(fal.runBriaExpand).not.toHaveBeenCalled();
  });

  it("returns 400 no_expansion when every pad is zero", async () => {
    db.findFirst.mockResolvedValue({ id: "g1", generatedImageUrl: "https://cdn/1.png", brandName: "X" });
    img.probeImageSize.mockResolvedValue({ width: 512, height: 512 });
    const res = await request(makeApp())
      .post("/api/generate/scale")
      .send({ generationId: "g1", pad: { top: 0, right: 0, bottom: 0, left: 0 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_expansion");
  });
});

/** Happy path: expand → 2x upscale → upload → replace source in place. */
describe("POST /api/generate/scale — pipeline", () => {
  it("caps each side to the image dimension and replaces the source in place", async () => {
    db.findFirst.mockResolvedValue({ id: "g1", generatedImageUrl: "https://cdn/src.png", brandName: "Goldzino(Men)" });
    img.probeImageSize.mockResolvedValue({ width: 512, height: 512 });
    fal.runBriaExpand.mockResolvedValue({ success: true, imageUrl: "https://fal/expanded.png" });
    fal.runSeedvrUpscale.mockResolvedValue({ success: true, imageUrl: "https://fal/upscaled.png" });
    cloud.uploadFromUrl.mockResolvedValue({ success: true, secure_url: "https://cdn/scaled.png" });
    db.update.mockResolvedValue({ id: "g1" });

    // Request 9999px on the left — must be capped to the width (512).
    const res = await request(makeApp())
      .post("/api/generate/scale")
      .send({ generationId: "g1", pad: { top: 0, right: 0, bottom: 0, left: 9999 }, prompt: "grass" });

    expect(res.status).toBe(200);
    expect(res.body.generatedImageUrl).toBe("https://cdn/scaled.png");

    // Canvas widened by the capped 512 (→ 1024), origin shifted by the same cap.
    const expandArg = fal.runBriaExpand.mock.calls[0][1];
    expect(expandArg.canvasW).toBe(1024);
    expect(expandArg.canvasH).toBe(512);
    expect(expandArg.originX).toBe(512);
    expect(expandArg.prompt).toBe("grass");

    // Upscales the expand result 2x, then persists the final URL to the same row.
    expect(fal.runSeedvrUpscale).toHaveBeenCalledWith("https://fal/expanded.png", 2);
    expect(cloud.uploadFromUrl).toHaveBeenCalledWith(
      "https://fal/upscaled.png",
      expect.stringContaining("scaled_g1_"),
      "scaled/Goldzino(Men)",
    );
    expect(db.update).toHaveBeenCalledWith({
      where: { id: "g1" },
      data: { generatedImageUrl: "https://cdn/scaled.png" },
    });
  });

  it("translates a Russian expand prompt to English before calling bria/expand", async () => {
    db.findFirst.mockResolvedValue({ id: "g1", generatedImageUrl: "https://cdn/src.png", brandName: "X" });
    img.probeImageSize.mockResolvedValue({ width: 512, height: 512 });
    fal.runBriaExpand.mockResolvedValue({ success: true, imageUrl: "https://fal/expanded.png" });
    fal.runSeedvrUpscale.mockResolvedValue({ success: true, imageUrl: "https://fal/upscaled.png" });
    cloud.uploadFromUrl.mockResolvedValue({ success: true, secure_url: "https://cdn/scaled.png" });
    db.update.mockResolvedValue({ id: "g1" });
    lang.ensureEnglishPrompt.mockResolvedValue({ ok: true, prompt: "green grass" });

    const res = await request(makeApp())
      .post("/api/generate/scale")
      .send({ ...okBody, prompt: "зелёная трава" });

    expect(res.status).toBe(200);
    expect(lang.ensureEnglishPrompt).toHaveBeenCalledWith("зелёная трава");
    expect(fal.runBriaExpand.mock.calls[0][1].prompt).toBe("green grass");
  });

  it("returns 502 prompt_translation_failed when the expand prompt can't be translated", async () => {
    db.findFirst.mockResolvedValue({ id: "g1", generatedImageUrl: "https://cdn/src.png", brandName: "X" });
    img.probeImageSize.mockResolvedValue({ width: 512, height: 512 });
    lang.ensureEnglishPrompt.mockResolvedValue({ ok: false });

    const res = await request(makeApp())
      .post("/api/generate/scale")
      .send({ ...okBody, prompt: "зелёная трава" });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("prompt_translation_failed");
    expect(fal.runBriaExpand).not.toHaveBeenCalled();
  });

  it("skips the translator entirely when no prompt is sent", async () => {
    db.findFirst.mockResolvedValue({ id: "g1", generatedImageUrl: "https://cdn/src.png", brandName: "X" });
    img.probeImageSize.mockResolvedValue({ width: 512, height: 512 });
    fal.runBriaExpand.mockResolvedValue({ success: true, imageUrl: "https://fal/expanded.png" });
    fal.runSeedvrUpscale.mockResolvedValue({ success: true, imageUrl: "https://fal/upscaled.png" });
    cloud.uploadFromUrl.mockResolvedValue({ success: true, secure_url: "https://cdn/scaled.png" });
    db.update.mockResolvedValue({ id: "g1" });

    const res = await request(makeApp()).post("/api/generate/scale").send(okBody);

    expect(res.status).toBe(200);
    expect(lang.ensureEnglishPrompt).not.toHaveBeenCalled();
    expect(fal.runBriaExpand.mock.calls[0][1].prompt).toBeUndefined();
  });

  it("falls back to the expanded image when upscale fails", async () => {
    db.findFirst.mockResolvedValue({ id: "g1", generatedImageUrl: "https://cdn/src.png", brandName: "X" });
    img.probeImageSize.mockResolvedValue({ width: 512, height: 512 });
    fal.runBriaExpand.mockResolvedValue({ success: true, imageUrl: "https://fal/expanded.png" });
    fal.runSeedvrUpscale.mockResolvedValue({ success: false, error: "boom" });
    cloud.uploadFromUrl.mockResolvedValue({ success: true, secure_url: "https://cdn/scaled.png" });
    db.update.mockResolvedValue({ id: "g1" });

    const res = await request(makeApp()).post("/api/generate/scale").send(okBody);

    expect(res.status).toBe(200);
    // Upload uses the (non-upscaled) expand URL as the fallback source.
    expect(cloud.uploadFromUrl.mock.calls[0][0]).toBe("https://fal/expanded.png");
  });

  it("returns 502 when the outpaint expand fails", async () => {
    db.findFirst.mockResolvedValue({ id: "g1", generatedImageUrl: "https://cdn/src.png", brandName: "X" });
    img.probeImageSize.mockResolvedValue({ width: 512, height: 512 });
    fal.runBriaExpand.mockResolvedValue({ success: false, error: "nope" });

    const res = await request(makeApp()).post("/api/generate/scale").send(okBody);

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("expand_failed");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("accepts a free-transform placement and clamps the canvas", async () => {
    db.findFirst.mockResolvedValue({ id: "g1", generatedImageUrl: "https://cdn/src.png", brandName: "X" });
    img.probeImageSize.mockResolvedValue({ width: 512, height: 512 });
    fal.runBriaExpand.mockResolvedValue({ success: true, imageUrl: "https://fal/expanded.png" });
    fal.runSeedvrUpscale.mockResolvedValue({ success: true, imageUrl: "https://fal/upscaled.png" });
    cloud.uploadFromUrl.mockResolvedValue({ success: true, secure_url: "https://cdn/scaled.png" });
    db.update.mockResolvedValue({ id: "g1" });

    // Zoomed-out image placed off-center on a 1000x800 canvas.
    const res = await request(makeApp())
      .post("/api/generate/scale")
      .send({
        generationId: "g1",
        placement: { canvasW: 1000, canvasH: 800, imgW: 400, imgH: 400, imgX: 100, imgY: 50 },
      });

    expect(res.status).toBe(200);
    const arg = fal.runBriaExpand.mock.calls[0][1];
    expect(arg).toMatchObject({ canvasW: 1000, canvasH: 800, imgW: 400, imgH: 400, originX: 100, originY: 50 });
  });

  it("rejects a placement where the image fills the whole canvas (no_expansion)", async () => {
    db.findFirst.mockResolvedValue({ id: "g1", generatedImageUrl: "https://cdn/src.png", brandName: "X" });
    img.probeImageSize.mockResolvedValue({ width: 512, height: 512 });

    const res = await request(makeApp())
      .post("/api/generate/scale")
      .send({
        generationId: "g1",
        placement: { canvasW: 512, canvasH: 512, imgW: 512, imgH: 512, imgX: 0, imgY: 0 },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_expansion");
    expect(fal.runBriaExpand).not.toHaveBeenCalled();
  });
});

/** POST /api/generate/inpaint — mask-based fill/erase via Bria (TASK §1). */
describe("POST /api/generate/inpaint", () => {
  const maskBody = {
    generationId: "g1",
    maskDataUrl: "data:image/png;base64,AAAA",
    mode: "fill",
    prompt: "a red car",
  };

  it("returns 400 empty_prompt when mode=fill has no prompt", async () => {
    const res = await request(makeApp())
      .post("/api/generate/inpaint")
      .send({ generationId: "g1", maskDataUrl: "data:image/png;base64,AAAA", mode: "fill" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("empty_prompt");
    expect(db.findFirst).not.toHaveBeenCalled();
  });

  it("fills a masked region via genfill and replaces the source", async () => {
    db.findFirst.mockResolvedValue({ id: "g1", generatedImageUrl: "https://cdn/src.png", brandName: "X" });
    cloud.uploadBase64.mockResolvedValue({ success: true, secure_url: "https://cdn/mask.png" });
    fal.runBriaGenfill.mockResolvedValue({ success: true, imageUrl: "https://fal/filled.png" });
    cloud.uploadFromUrl.mockResolvedValue({ success: true, secure_url: "https://cdn/inpainted.png" });
    db.update.mockResolvedValue({ id: "g1" });

    const res = await request(makeApp()).post("/api/generate/inpaint").send(maskBody);

    expect(res.status).toBe(200);
    expect(res.body.generatedImageUrl).toBe("https://cdn/inpainted.png");
    expect(fal.runBriaGenfill).toHaveBeenCalledWith("https://cdn/src.png", "https://cdn/mask.png", "a red car");
    expect(fal.runBriaEraser).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledWith({
      where: { id: "g1" },
      data: { generatedImageUrl: "https://cdn/inpainted.png" },
    });
  });

  it("erases a masked region via eraser (no prompt needed)", async () => {
    db.findFirst.mockResolvedValue({ id: "g1", generatedImageUrl: "https://cdn/src.png", brandName: "X" });
    cloud.uploadBase64.mockResolvedValue({ success: true, secure_url: "https://cdn/mask.png" });
    fal.runBriaEraser.mockResolvedValue({ success: true, imageUrl: "https://fal/erased.png" });
    cloud.uploadFromUrl.mockResolvedValue({ success: true, secure_url: "https://cdn/inpainted.png" });
    db.update.mockResolvedValue({ id: "g1" });

    const res = await request(makeApp())
      .post("/api/generate/inpaint")
      .send({ generationId: "g1", maskDataUrl: "data:image/png;base64,AAAA", mode: "erase" });

    expect(res.status).toBe(200);
    expect(fal.runBriaEraser).toHaveBeenCalledWith("https://cdn/src.png", "https://cdn/mask.png");
    expect(fal.runBriaGenfill).not.toHaveBeenCalled();
  });

  it("translates a Russian fill prompt to English before calling genfill", async () => {
    db.findFirst.mockResolvedValue({ id: "g1", generatedImageUrl: "https://cdn/src.png", brandName: "X" });
    cloud.uploadBase64.mockResolvedValue({ success: true, secure_url: "https://cdn/mask.png" });
    fal.runBriaGenfill.mockResolvedValue({ success: true, imageUrl: "https://fal/filled.png" });
    cloud.uploadFromUrl.mockResolvedValue({ success: true, secure_url: "https://cdn/inpainted.png" });
    db.update.mockResolvedValue({ id: "g1" });
    lang.ensureEnglishPrompt.mockResolvedValue({ ok: true, prompt: "a red car" });

    const res = await request(makeApp())
      .post("/api/generate/inpaint")
      .send({ ...maskBody, prompt: "красная машина" });

    expect(res.status).toBe(200);
    expect(lang.ensureEnglishPrompt).toHaveBeenCalledWith("красная машина");
    // Bria receives the TRANSLATED prompt, never the raw non-ASCII one.
    expect(fal.runBriaGenfill).toHaveBeenCalledWith("https://cdn/src.png", "https://cdn/mask.png", "a red car");
  });

  it("returns 502 prompt_translation_failed when translation fails (before mask upload)", async () => {
    db.findFirst.mockResolvedValue({ id: "g1", generatedImageUrl: "https://cdn/src.png", brandName: "X" });
    lang.ensureEnglishPrompt.mockResolvedValue({ ok: false });

    const res = await request(makeApp())
      .post("/api/generate/inpaint")
      .send({ ...maskBody, prompt: "красная машина" });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("prompt_translation_failed");
    expect(cloud.uploadBase64).not.toHaveBeenCalled();
    expect(fal.runBriaGenfill).not.toHaveBeenCalled();
  });

  it("does not consult the translator in erase mode (no prompt involved)", async () => {
    db.findFirst.mockResolvedValue({ id: "g1", generatedImageUrl: "https://cdn/src.png", brandName: "X" });
    cloud.uploadBase64.mockResolvedValue({ success: true, secure_url: "https://cdn/mask.png" });
    fal.runBriaEraser.mockResolvedValue({ success: true, imageUrl: "https://fal/erased.png" });
    cloud.uploadFromUrl.mockResolvedValue({ success: true, secure_url: "https://cdn/inpainted.png" });
    db.update.mockResolvedValue({ id: "g1" });

    const res = await request(makeApp())
      .post("/api/generate/inpaint")
      .send({ generationId: "g1", maskDataUrl: "data:image/png;base64,AAAA", mode: "erase" });

    expect(res.status).toBe(200);
    expect(lang.ensureEnglishPrompt).not.toHaveBeenCalled();
  });

  it("returns 502 when the mask upload fails", async () => {
    db.findFirst.mockResolvedValue({ id: "g1", generatedImageUrl: "https://cdn/src.png", brandName: "X" });
    cloud.uploadBase64.mockResolvedValue({ success: false, error: "boom" });

    const res = await request(makeApp()).post("/api/generate/inpaint").send(maskBody);

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("mask_upload_failed");
    expect(fal.runBriaGenfill).not.toHaveBeenCalled();
  });
});
