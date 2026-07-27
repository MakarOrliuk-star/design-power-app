import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import sharp from "sharp";

// Layer cache orchestration (TASK email-composition, Phase 2): prisma, fal and
// cloudinary are mocked; fetch is stubbed; normalization runs for real.
const db = vi.hoisted(() => ({
  normalizedLayer: { findUnique: vi.fn(), upsert: vi.fn() },
}));
const fal = vi.hoisted(() => ({ runBriaRemoveBg: vi.fn() }));
const cloud = vi.hoisted(() => ({
  uploadBuffer: vi.fn(),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock("../src/lib/prisma.js", () => ({ prisma: db }));
vi.mock("../src/lib/fal.js", () => fal);
vi.mock("../src/lib/cloudinary.js", () => cloud);

import { getOrCreateNormalizedLayer, sourceHashOf, LAYER_FOLDER } from "../src/services/layerCache.js";

/** Opaque JPEG-style PNG (no useful alpha) and a real cutout PNG. */
async function opaquePng(): Promise<Buffer> {
  return sharp({
    create: { width: 60, height: 60, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .png()
    .toBuffer();
}
async function cutoutPng(): Promise<Buffer> {
  const data = Buffer.alloc(60 * 60 * 4, 0);
  for (let y = 10; y < 50; y++)
    for (let x = 20; x < 40; x++) {
      const i = (y * 60 + x) * 4;
      data[i] = 10;
      data[i + 1] = 200;
      data[i + 2] = 10;
      data[i + 3] = 255;
    }
  return sharp(data, { raw: { width: 60, height: 60, channels: 4 } }).png().toBuffer();
}

const fetchMock = vi.fn();

beforeEach(() => {
  db.normalizedLayer.findUnique.mockReset();
  db.normalizedLayer.upsert.mockReset();
  fal.runBriaRemoveBg.mockReset();
  cloud.uploadBuffer.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

function okResponse(buf: Buffer) {
  return { ok: true, arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)) };
}

describe("getOrCreateNormalizedLayer", () => {
  it("cache hit: returns the stored row, no BR / normalize / upload", async () => {
    const src = await cutoutPng();
    fetchMock.mockResolvedValueOnce(okResponse(src));
    db.normalizedLayer.findUnique.mockResolvedValue({
      publicId: "layers/layer_abc",
      url: "https://cdn/layers/layer_abc.png",
      width: 20,
      height: 40,
    });

    const r = await getOrCreateNormalizedLayer("https://cdn/src.png", "person#v1");
    expect(r).toMatchObject({ ok: true, cached: true, publicId: "layers/layer_abc", width: 20 });
    expect(db.normalizedLayer.findUnique).toHaveBeenCalledWith({
      where: { sourceHash: sourceHashOf(src) },
    });
    expect(fal.runBriaRemoveBg).not.toHaveBeenCalled();
    expect(cloud.uploadBuffer).not.toHaveBeenCalled();
  });

  it("miss + opaque source: BR fallback runs, layer is normalized, uploaded deterministically", async () => {
    const src = await opaquePng();
    const cut = await cutoutPng();
    fetchMock
      .mockResolvedValueOnce(okResponse(src)) // source download
      .mockResolvedValueOnce(okResponse(cut)); // BR result download
    db.normalizedLayer.findUnique.mockResolvedValue(null);
    fal.runBriaRemoveBg.mockResolvedValue({ success: true, imageUrl: "https://fal/cut.png" });
    cloud.uploadBuffer.mockResolvedValue({
      success: true,
      secure_url: "https://cdn/layers/x.png",
      public_id: "layers/layer_x",
    });
    db.normalizedLayer.upsert.mockImplementation(({ create }: { create: Record<string, unknown> }) =>
      Promise.resolve({ id: "n1", ...create }),
    );

    const r = await getOrCreateNormalizedLayer("https://cdn/src.png", "item#v1");
    expect(fal.runBriaRemoveBg).toHaveBeenCalledWith("https://cdn/src.png");
    const hash = sourceHashOf(src);
    expect(cloud.uploadBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      `layer_${hash.slice(0, 20)}`,
      LAYER_FOLDER,
    );
    // bbox of the synthetic cutout subject: 20×40
    expect(db.normalizedLayer.upsert).toHaveBeenCalledWith({
      where: { sourceHash: hash },
      create: expect.objectContaining({ sourceHash: hash, width: 20, height: 40 }),
      update: {},
    });
    expect(r).toMatchObject({ ok: true, cached: false, hash, width: 20, height: 40 });
  });

  it("miss + source already transparent: BR is skipped (provider-proof contract)", async () => {
    const src = await cutoutPng();
    fetchMock.mockResolvedValueOnce(okResponse(src));
    db.normalizedLayer.findUnique.mockResolvedValue(null);
    cloud.uploadBuffer.mockResolvedValue({
      success: true,
      secure_url: "https://cdn/l.png",
      public_id: "layers/layer_y",
    });
    db.normalizedLayer.upsert.mockImplementation(({ create }: { create: Record<string, unknown> }) =>
      Promise.resolve({ id: "n2", ...create }),
    );

    const r = await getOrCreateNormalizedLayer("https://cdn/cutout.png", "person#v2");
    expect(fal.runBriaRemoveBg).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, width: 20, height: 40 });
  });

  it("BR failure propagates a readable reason (asset ends FAILED, not broken image)", async () => {
    const src = await opaquePng();
    fetchMock.mockResolvedValueOnce(okResponse(src));
    db.normalizedLayer.findUnique.mockResolvedValue(null);
    fal.runBriaRemoveBg.mockResolvedValue({ success: false, error: "nsfw filter" });

    const r = await getOrCreateNormalizedLayer("https://cdn/src.png", "person#v3");
    expect(r).toEqual({ ok: false, reason: "background removal: nsfw filter" });
    expect(cloud.uploadBuffer).not.toHaveBeenCalled();
  });

  it("source download failure short-circuits", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });
    const r = await getOrCreateNormalizedLayer("https://cdn/gone.png", "item#v4");
    expect(r).toEqual({ ok: false, reason: "source download failed" });
    expect(db.normalizedLayer.findUnique).not.toHaveBeenCalled();
  });
});
