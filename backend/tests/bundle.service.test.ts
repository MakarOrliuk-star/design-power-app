import { describe, it, expect, beforeEach, vi } from "vitest";

// The service touches prisma + the BullMQ bundle queue — mock both.
const db = vi.hoisted(() => ({
  brand: { findMany: vi.fn() },
  bundle: { findUnique: vi.fn(), update: vi.fn() },
  bundleAsset: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  bundleBrandVariant: { deleteMany: vi.fn(), upsert: vi.fn() },
  $transaction: vi.fn(),
}));
const queue = vi.hoisted(() => ({ add: vi.fn(), addBulk: vi.fn() }));

vi.mock("../src/lib/prisma.js", () => ({ prisma: db }));
vi.mock("../src/queues/index.js", () => ({ getBundleQueue: () => queue }));

import {
  editAsset,
  expandBrandVariants,
  launchGeneration,
  listBundleBrands,
  regenerateAsset,
  stripGenderName,
  variantDisplayName,
} from "../src/services/bundle.service.js";

beforeEach(() => {
  for (const delegate of Object.values(db)) {
    if (typeof delegate === "function") (delegate as ReturnType<typeof vi.fn>).mockReset();
    else for (const fn of Object.values(delegate)) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  queue.add.mockReset();
  queue.addBulk.mockReset();
});

/**
 * BE Test — brand grouping (D3/D7): ONLY the trailing (Men)/(Women) tone
 * suffix merges into one picker toggle; other parenthetical variants and
 * token names stay separate brands.
 */
describe("stripGenderName / variantDisplayName", () => {
  it("strips only the gender suffix", () => {
    expect(stripGenderName("Betnella(Men)")).toBe("Betnella");
    expect(stripGenderName("Betnella (Women)")).toBe("Betnella");
    expect(stripGenderName("Oscar(man)")).toBe("Oscar");
    expect(stripGenderName("Corgi")).toBe("Corgi");
    expect(stripGenderName("Booongo(Monkey)")).toBe("Booongo(Monkey)");
    expect(stripGenderName("Frogyspin_women_black")).toBe("Frogyspin_women_black");
  });

  it("formats the UI label with a space + normalized suffix", () => {
    expect(variantDisplayName("Betnella(Men)")).toBe("Betnella (Men)");
    expect(variantDisplayName("Oscar(woman)")).toBe("Oscar (Women)");
    expect(variantDisplayName("Corgi")).toBe("Corgi");
  });
});

describe("listBundleBrands", () => {
  it("groups (Men)/(Women) under one base and keeps singles standalone", async () => {
    db.brand.findMany.mockResolvedValue([
      { name: "Betnella(Men)" },
      { name: "Betnella(Women)" },
      { name: "Booongo(Monkey)" },
      { name: "Corgi" },
    ]);
    const groups = await listBundleBrands();
    expect(groups.map((g) => g.key)).toEqual(["Betnella", "Booongo(Monkey)", "Corgi"]);
    expect(groups[0]!.variants.map((v) => v.displayName)).toEqual([
      "Betnella (Men)",
      "Betnella (Women)",
    ]);
    expect(groups[2]!.variants).toHaveLength(1);
  });
});

describe("expandBrandVariants", () => {
  it("expands base names into the actually existing active variants", async () => {
    db.brand.findMany.mockResolvedValue([
      { id: "b1", name: "Betnella(Men)" },
      { id: "b2", name: "Betnella(Women)" },
      { id: "b3", name: "Corgi" },
      { id: "b4", name: "Boomzino(Men)" },
    ]);
    const variants = await expandBrandVariants(["Betnella", "Corgi"]);
    expect(variants).toEqual([
      { brandId: "b1", brandName: "Betnella(Men)", displayName: "Betnella (Men)" },
      { brandId: "b2", brandName: "Betnella(Women)", displayName: "Betnella (Women)" },
      { brandId: "b3", brandName: "Corgi", displayName: "Corgi" },
    ]);
  });
});

/** Fake $transaction: runs the callback against tx-scoped mock delegates. */
function mockTransaction() {
  const tx = {
    bundleBrandVariant: {
      deleteMany: vi.fn(),
      upsert: vi.fn().mockImplementation(({ where }) =>
        Promise.resolve({ id: `v_${where.bundleId_brandName.brandName}` }),
      ),
    },
    bundleAsset: { upsert: vi.fn() },
    bundle: { update: vi.fn() },
  };
  db.$transaction.mockImplementation(async (cb: (t: unknown) => Promise<void>) => cb(tx));
  return tx;
}

describe("launchGeneration", () => {
  const bundleRow = {
    id: "bun1",
    status: "DRAFT",
    brandNames: ["Betnella"],
    bundleType: {
      assets: [
        { key: "email", label: "Email", width: 1200, height: 600 },
        { key: "popup", label: "Pop-up", width: 800, height: 600 },
        { key: "push", label: "Push", width: 1024, height: 512 },
      ],
    },
  };

  it("expands variants, resets assets, sets GENERATING and enqueues stage A", async () => {
    db.bundle.findUnique.mockResolvedValue(bundleRow);
    db.brand.findMany.mockResolvedValue([
      { id: "b1", name: "Betnella(Men)" },
      { id: "b2", name: "Betnella(Women)" },
    ]);
    const tx = mockTransaction();
    queue.addBulk.mockResolvedValue([]);

    const result = await launchGeneration("bun1");
    expect(result).toEqual({ ok: true, variantCount: 2, assetCount: 6 });
    // 2 variants × 3 assets reset with canonical mask sizes (D2).
    expect(tx.bundleAsset.upsert).toHaveBeenCalledTimes(6);
    expect(tx.bundle.update).toHaveBeenCalledWith({
      where: { id: "bun1" },
      data: { status: "GENERATING" },
    });
    expect(queue.addBulk).toHaveBeenCalledOnce();
    const jobs = queue.addBulk.mock.calls[0]![0] as Array<{ name: string }>;
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.name === "prepare-variant")).toBe(true);
  });

  it("409s a re-launch while already GENERATING", async () => {
    db.bundle.findUnique.mockResolvedValue({ ...bundleRow, status: "GENERATING" });
    expect(await launchGeneration("bun1")).toEqual({ ok: false, error: "already_generating" });
  });

  it("400s when no selected base name matches an active brand", async () => {
    db.bundle.findUnique.mockResolvedValue({ ...bundleRow, brandNames: ["Ghost"] });
    db.brand.findMany.mockResolvedValue([{ id: "b1", name: "Betnella(Men)" }]);
    expect(await launchGeneration("bun1")).toEqual({ ok: false, error: "no_brands" });
  });

  it("marks assets FAILED when the queue is unavailable", async () => {
    db.bundle.findUnique.mockResolvedValue(bundleRow);
    db.brand.findMany.mockResolvedValue([{ id: "b1", name: "Betnella(Men)" }]);
    mockTransaction();
    queue.addBulk.mockRejectedValue(new Error("redis down"));
    db.bundleAsset.findMany.mockResolvedValue([{ status: "FAILED" }]); // recompute read

    const result = await launchGeneration("bun1");
    expect(result).toEqual({ ok: false, error: "queue_unavailable" });
    expect(db.bundleAsset.updateMany).toHaveBeenCalledWith({
      where: { bundleId: "bun1" },
      data: { status: "FAILED", errorMessage: "queue_unavailable" },
    });
    // Derived status lands on FAILED (recomputeBundleStatus).
    expect(db.bundle.update).toHaveBeenCalledWith({
      where: { id: "bun1" },
      data: { status: "FAILED" },
    });
  });

  it("returns null for an unknown bundle", async () => {
    db.bundle.findUnique.mockResolvedValue(null);
    expect(await launchGeneration("nope")).toBeNull();
  });
});

describe("editAsset (D9)", () => {
  it("enqueues an edit-asset job for a finished asset and resets approve", async () => {
    db.bundleAsset.findFirst.mockResolvedValue({
      id: "a1",
      status: "DONE",
      imageUrl: "https://cdn/email.png",
      variantId: "v1",
    });
    queue.add.mockResolvedValue({});

    const result = await editAsset("bun1", "a1", "warmer background");
    expect(result).toEqual({ ok: true });
    expect(db.bundleAsset.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { status: "GENERATING", approved: false, errorMessage: null },
    });
    expect(queue.add).toHaveBeenCalledWith("edit-asset", {
      bundleId: "bun1",
      variantId: "v1",
      assetId: "a1",
      editPrompt: "warmer background",
    });
  });

  it("409s an asset that is not DONE / has no image", async () => {
    db.bundleAsset.findFirst.mockResolvedValue({
      id: "a1",
      status: "FAILED",
      imageUrl: null,
      variantId: "v1",
    });
    expect(await editAsset("bun1", "a1", "x")).toEqual({ ok: false, error: "not_editable" });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("marks the asset FAILED when the queue is unavailable", async () => {
    db.bundleAsset.findFirst.mockResolvedValue({
      id: "a1",
      status: "DONE",
      imageUrl: "https://cdn/email.png",
      variantId: "v1",
    });
    queue.add.mockRejectedValue(new Error("redis down"));
    db.bundleAsset.findMany.mockResolvedValue([{ status: "FAILED" }]); // recompute read

    expect(await editAsset("bun1", "a1", "x")).toEqual({ ok: false, error: "queue_unavailable" });
    expect(db.bundleAsset.update).toHaveBeenLastCalledWith({
      where: { id: "a1" },
      data: { status: "FAILED", errorMessage: "queue_unavailable" },
    });
  });
});

describe("regenerateAsset", () => {
  it("re-renders stage B only when the variant artifacts exist", async () => {
    db.bundleAsset.findFirst.mockResolvedValue({
      id: "a1",
      status: "DONE",
      variant: { id: "v1", personImageUrl: "https://cdn/person.png" },
    });
    queue.add.mockResolvedValue({});

    const result = await regenerateAsset("bun1", "a1");
    expect(result).toEqual({ ok: true });
    // Approve resets on regenerate (state machine rule).
    expect(db.bundleAsset.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { status: "GENERATING", approved: false, errorMessage: null },
    });
    expect(queue.add).toHaveBeenCalledWith("render-asset", {
      bundleId: "bun1",
      variantId: "v1",
      assetId: "a1",
    });
  });

  it("falls back to stage A when the variant has no person artifact", async () => {
    db.bundleAsset.findFirst.mockResolvedValue({
      id: "a1",
      status: "FAILED",
      variant: { id: "v1", personImageUrl: null },
    });
    queue.add.mockResolvedValue({});

    expect(await regenerateAsset("bun1", "a1")).toEqual({ ok: true });
    expect(queue.add).toHaveBeenCalledWith("prepare-variant", { bundleId: "bun1", variantId: "v1" });
  });

  it("409s an asset that is already in flight", async () => {
    db.bundleAsset.findFirst.mockResolvedValue({
      id: "a1",
      status: "GENERATING",
      variant: { id: "v1", personImageUrl: null },
    });
    expect(await regenerateAsset("bun1", "a1")).toEqual({ ok: false, error: "in_flight" });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("returns null when the asset does not belong to the bundle", async () => {
    db.bundleAsset.findFirst.mockResolvedValue(null);
    expect(await regenerateAsset("bun1", "foreign")).toBeNull();
  });
});
