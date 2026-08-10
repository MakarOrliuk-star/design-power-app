import { describe, it, expect, beforeEach, vi } from "vitest";

// The service touches prisma + the BullMQ bundle queue — mock both.
const db = vi.hoisted(() => ({
  brand: { findMany: vi.fn() },
  bundle: { findUnique: vi.fn(), update: vi.fn() },
  bundleAsset: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
  bundleBrandVariant: { deleteMany: vi.fn(), upsert: vi.fn() },
  variationReference: { groupBy: vi.fn() },
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
  resolveStyleAnchorKey,
  dependentAiReferenceAssets,
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
    // deleteMany — чистка производных ai_reference-строк прошлого запуска.
    bundleAsset: { upsert: vi.fn(), deleteMany: vi.fn() },
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

  // Гейт ai_reference (DI-R3 + TASK multiformat-promo, DI2-2): референсы нужны
  // на КАЖДЫЙ формат — email хватает, push пустой → генерация не стартует.
  describe("гейт ai_reference по форматам", () => {
    const aiRefBundle = {
      ...bundleRow,
      presetId: "p1",
      bundleType: {
        assets: [
          { key: "email", label: "Email", width: 1200, height: 600, composeMode: "ai_reference" },
          { key: "push", label: "Push", width: 1024, height: 512, composeMode: "ai_reference" },
        ],
      },
    };

    it("422 refs_missing с указанием конкретного формата", async () => {
      db.bundle.findUnique.mockResolvedValue(aiRefBundle);
      db.brand.findMany.mockResolvedValue([{ id: "b1", name: "Betnella(Men)" }]);
      db.variationReference.groupBy.mockResolvedValue([
        { brandName: "Betnella", assetKey: "email", _count: { _all: 8 } },
        { brandName: "Betnella", assetKey: "push", _count: { _all: 2 } },
      ]);

      const result = await launchGeneration("bun1");
      expect(result).toEqual({
        ok: false,
        error: "refs_missing",
        missingRefs: [{ brandName: "Betnella", assetKey: "push", count: 2, min: 5 }],
      });
      expect(queue.addBulk).not.toHaveBeenCalled();
    });

    it("хватает на всех форматах → генерация стартует", async () => {
      db.bundle.findUnique.mockResolvedValue(aiRefBundle);
      db.brand.findMany.mockResolvedValue([{ id: "b1", name: "Betnella(Men)" }]);
      db.variationReference.groupBy.mockResolvedValue([
        { brandName: "Betnella", assetKey: "email", _count: { _all: 8 } },
        { brandName: "Betnella", assetKey: "push", _count: { _all: 5 } },
      ]);
      mockTransaction();
      queue.addBulk.mockResolvedValue([]);

      expect(await launchGeneration("bun1")).toEqual({
        ok: true,
        variantCount: 1,
        assetCount: 2,
      });
    });

    it("вариация не выбрана → preset_required (референсы даже не читаются)", async () => {
      db.bundle.findUnique.mockResolvedValue({ ...aiRefBundle, presetId: null });
      db.brand.findMany.mockResolvedValue([{ id: "b1", name: "Betnella(Men)" }]);
      expect(await launchGeneration("bun1")).toEqual({ ok: false, error: "preset_required" });
      expect(db.variationReference.groupBy).not.toHaveBeenCalled();
    });
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

/** Тип бандла без ai_reference — каскад стиля не применяется. */
const LAYERED_ASSETS = [
  { key: "email", label: "Email", width: 1200, height: 600, composeMode: "layered" },
];
/** Мультиформатное промо (TASK multiformat-promo): якорь email + push/pop-up. */
const AI_REF_ASSETS = [
  { key: "email", label: "Email", width: 1200, height: 600, composeMode: "ai_reference" },
  { key: "popup", label: "Pop-up", width: 800, height: 600, composeMode: "ai_reference" },
  { key: "push", label: "Push", width: 1024, height: 512, composeMode: "ai_reference" },
];

describe("resolveStyleAnchorKey / dependentAiReferenceAssets (A2-1)", () => {
  it("якорь по умолчанию — email, зависимые — остальные ai_reference-форматы", () => {
    expect(resolveStyleAnchorKey(AI_REF_ASSETS)).toBe("email");
    expect(dependentAiReferenceAssets(AI_REF_ASSETS).map((a) => a.key)).toEqual(["popup", "push"]);
  });

  it("явный styleAnchor побеждает правило «email»", () => {
    const assets = [
      { key: "email", label: "Email", width: 1200, height: 600, composeMode: "ai_reference" as const },
      {
        key: "push",
        label: "Push",
        width: 1024,
        height: 512,
        composeMode: "ai_reference" as const,
        styleAnchor: true,
      },
    ];
    expect(resolveStyleAnchorKey(assets)).toBe("push");
    expect(dependentAiReferenceAssets(assets).map((a) => a.key)).toEqual(["email"]);
  });

  it("нет ai_reference-ассетов → якоря нет, каскад не запускается", () => {
    expect(resolveStyleAnchorKey(LAYERED_ASSETS)).toBeNull();
    expect(dependentAiReferenceAssets(LAYERED_ASSETS)).toEqual([]);
  });
});

describe("regenerateAsset", () => {
  it("re-renders stage B only when the variant artifacts exist", async () => {
    db.bundleAsset.findFirst.mockResolvedValue({
      id: "a1",
      status: "DONE",
      assetKey: "email",
      variant: {
        id: "v1",
        personImageUrl: "https://cdn/person.png",
        bundle: { bundleType: { assets: LAYERED_ASSETS } },
      },
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
      assetKey: "email",
      variant: {
        id: "v1",
        personImageUrl: null,
        bundle: { bundleType: { assets: LAYERED_ASSETS } },
      },
    });
    queue.add.mockResolvedValue({});

    expect(await regenerateAsset("bun1", "a1")).toEqual({ ok: true });
    expect(queue.add).toHaveBeenCalledWith("prepare-variant", { bundleId: "bun1", variantId: "v1" });
  });

  it("409s an asset that is already in flight", async () => {
    db.bundleAsset.findFirst.mockResolvedValue({
      id: "a1",
      status: "GENERATING",
      assetKey: "email",
      variant: {
        id: "v1",
        personImageUrl: null,
        bundle: { bundleType: { assets: LAYERED_ASSETS } },
      },
    });
    expect(await regenerateAsset("bun1", "a1")).toEqual({ ok: false, error: "in_flight" });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("returns null when the asset does not belong to the bundle", async () => {
    db.bundleAsset.findFirst.mockResolvedValue(null);
    expect(await regenerateAsset("bun1", "foreign")).toBeNull();
  });

  // TASK multiformat-promo (DI2-9): единый стиль кампании задаёт email, поэтому
  // его перегенерация обязана утянуть за собой push и pop-up.
  it("каскад: Regenerate якоря сбрасывает зависимые форматы, в очередь идёт только якорь", async () => {
    db.bundleAsset.findFirst.mockResolvedValue({
      id: "a1",
      status: "DONE",
      assetKey: "email",
      variant: {
        id: "v1",
        personImageUrl: null,
        bundle: { bundleType: { assets: AI_REF_ASSETS } },
      },
    });
    db.bundleAsset.count.mockResolvedValue(0);
    queue.add.mockResolvedValue({});

    expect(await regenerateAsset("bun1", "a1")).toEqual({ ok: true });
    expect(db.bundleAsset.updateMany).toHaveBeenCalledWith({
      where: { variantId: "v1", assetKey: { in: ["popup", "push"] } },
      data: { status: "GENERATING", approved: false, errorMessage: null },
    });
    // Зависимые поставит процессор якоря после его успеха — не здесь.
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it("каскад блокируется, пока зависимый формат ещё в полёте", async () => {
    db.bundleAsset.findFirst.mockResolvedValue({
      id: "a1",
      status: "DONE",
      assetKey: "email",
      variant: {
        id: "v1",
        personImageUrl: null,
        bundle: { bundleType: { assets: AI_REF_ASSETS } },
      },
    });
    db.bundleAsset.count.mockResolvedValue(1);

    expect(await regenerateAsset("bun1", "a1")).toEqual({ ok: false, error: "in_flight" });
    expect(queue.add).not.toHaveBeenCalled();
    expect(db.bundleAsset.update).not.toHaveBeenCalled();
  });

  it("Regenerate зависимого формата якорь не трогает", async () => {
    db.bundleAsset.findFirst.mockResolvedValue({
      id: "a2",
      status: "DONE",
      assetKey: "push",
      variant: {
        id: "v1",
        personImageUrl: null,
        bundle: { bundleType: { assets: AI_REF_ASSETS } },
      },
    });
    queue.add.mockResolvedValue({});

    expect(await regenerateAsset("bun1", "a2")).toEqual({ ok: true });
    expect(db.bundleAsset.updateMany).not.toHaveBeenCalled();
  });
});
