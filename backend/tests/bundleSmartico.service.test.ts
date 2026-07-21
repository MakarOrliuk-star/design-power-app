import { describe, it, expect, beforeEach, vi } from "vitest";

// prisma, the Cloudinary upload and env are mocked; the brand normalization
// (detect.ts) and function emission (generate.ts) run for REAL — the emitted
// snippets are the contract this test protects.
const db = vi.hoisted(() => ({
  bundle: { findUnique: vi.fn() },
  bundleSend: { create: vi.fn(), update: vi.fn() },
  smarticoBrand: { findMany: vi.fn() },
}));
const upload = vi.hoisted(() => vi.fn());
const envMock = vi.hoisted(() => ({ cloudinaryConfigured: true, env: {} }));

vi.mock("../src/lib/prisma.js", () => ({ prisma: db }));
vi.mock("../src/lib/smartico/uploadAsset.js", () => ({ uploadSmarticoAsset: upload }));
vi.mock("../src/env.js", () => envMock);

import { sendBundleToSmartico } from "../src/services/bundleSmartico.service.js";

function approvedAsset(assetKey: string) {
  return { assetKey, imageUrl: `https://cdn/${assetKey}.png`, approved: true, status: "DONE" };
}

const okFetch = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));

beforeEach(() => {
  db.bundle.findUnique.mockReset();
  db.bundleSend.create.mockReset().mockResolvedValue({ id: "send1" });
  db.bundleSend.update.mockReset().mockResolvedValue({});
  db.smarticoBrand.findMany.mockReset().mockResolvedValue([{ name: "Betnella" }]);
  upload.mockReset().mockResolvedValue({ url: "https://smartico.cdn/x.png", status: "uploaded" });
  envMock.cloudinaryConfigured = true;
  vi.stubGlobal("fetch", okFetch);
  okFetch.mockClear();
});

/**
 * BE Test — Send to Smartico (Phase 6, D6/D14): approved assets are re-uploaded
 * via the Unique Smartico dedup path and emitted as Men/Women function sets
 * keyed by the canonical SmarticoBrand names.
 */
describe("sendBundleToSmartico", () => {
  it("groups gendered variants into Men/Women buckets; neutral brands go to both", async () => {
    db.bundle.findUnique.mockResolvedValue({
      id: "bun1",
      variants: [
        { brandName: "Betnella(Men)", assets: [approvedAsset("email")] },
        { brandName: "Betnella(Women)", assets: [approvedAsset("email")] },
        { brandName: "Corgi", assets: [approvedAsset("email")] },
      ],
    });

    const result = await sendBundleToSmartico("bun1");
    expect(result).toMatchObject({ ok: true, sendId: "send1" });
    if (!result || !result.ok) throw new Error("unreachable");

    // Two tone buckets, one Email function each.
    expect(result.outputs.map((o) => o.title)).toEqual([
      "Men — Email — Function",
      "Women — Email — Function",
    ]);
    // Canonical Smartico name is the subjectLine key (base name, no tone suffix).
    expect(result.outputs[0]!.code).toContain('"Betnella": "https://smartico.cdn/x.png"');
    expect(result.outputs[0]!.code).toContain("state.core_sm_brand_id");
    // The neutral brand lands in BOTH buckets and is flagged as suspicious
    // (missing from the SmarticoBrand table).
    expect(result.outputs[0]!.code).toContain('"Corgi"');
    expect(result.outputs[1]!.code).toContain('"Corgi"');
    expect(result.stats.suspicious).toEqual(["Corgi"]);

    // Upload path: dedup key is the RAW variant name (distinct per tone).
    expect(upload).toHaveBeenCalledTimes(3);
    expect(upload.mock.calls[0]![1]).toEqual({
      namespace: "bundle-bun1",
      brand: "Betnella(Men)",
      type: "email",
      locale: "default",
    });
    // Result persisted for history / idempotent re-open.
    expect(db.bundleSend.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "send1" }, data: expect.objectContaining({ status: "DONE" }) }),
    );
  });

  it("emits a single unlabeled set when the bundle has no gendered variants", async () => {
    db.bundle.findUnique.mockResolvedValue({
      id: "bun1",
      variants: [{ brandName: "Corgi", assets: [approvedAsset("email"), approvedAsset("popup")] }],
    });

    const result = await sendBundleToSmartico("bun1");
    if (!result || !result.ok) throw new Error("expected ok");
    expect(result.outputs.map((o) => o.title)).toEqual(["Email — Function", "Pop-up — Function"]);
    // Bundle "popup" maps to the Smartico "pop-up" type key.
    expect(upload.mock.calls.map((c) => (c[1] as { type: string }).type)).toEqual(["email", "pop-up"]);
  });

  it("400s when nothing is approved", async () => {
    db.bundle.findUnique.mockResolvedValue({
      id: "bun1",
      variants: [{ brandName: "Betnella(Men)", assets: [] }],
    });
    expect(await sendBundleToSmartico("bun1")).toEqual({ ok: false, error: "no_approved_assets" });
    expect(db.bundleSend.create).not.toHaveBeenCalled();
  });

  it("503s when Cloudinary is not configured", async () => {
    envMock.cloudinaryConfigured = false;
    expect(await sendBundleToSmartico("bun1")).toEqual({ ok: false, error: "cloudinary_not_configured" });
  });

  it("counts fetch/upload failures per asset without failing the send", async () => {
    db.bundle.findUnique.mockResolvedValue({
      id: "bun1",
      variants: [
        { brandName: "Betnella(Men)", assets: [approvedAsset("email")] },
        { brandName: "Betnella(Women)", assets: [approvedAsset("email")] },
      ],
    });
    upload
      .mockResolvedValueOnce({ url: "https://smartico.cdn/ok.png", status: "reused" })
      .mockResolvedValueOnce({ url: null, status: "failed", error: "cloudinary 500" });

    const result = await sendBundleToSmartico("bun1");
    if (!result || !result.ok) throw new Error("expected ok");
    expect(result.stats).toMatchObject({ total: 2, uploaded: 0, reused: 1, failed: 1 });
    expect(result.stats.failedItems[0]).toContain("Betnella(Women)/email");
    // Only the successful asset appears in the functions.
    expect(result.outputs.map((o) => o.title)).toEqual(["Men — Email — Function"]);
  });

  it("returns null for an unknown bundle", async () => {
    db.bundle.findUnique.mockResolvedValue(null);
    expect(await sendBundleToSmartico("nope")).toBeNull();
  });
});
