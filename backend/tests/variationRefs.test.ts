import { describe, it, expect, beforeEach, vi } from "vitest";

const db = vi.hoisted(() => ({
  variationReference: { findMany: vi.fn(), groupBy: vi.fn() },
}));
vi.mock("../src/lib/prisma.js", () => ({ prisma: db }));

import {
  pickGenerationRefs,
  refCountsByBrand,
  countFor,
  refsFolder,
  brandSlug,
  MAX_EDIT_REFS,
  MIN_REFS_FOR_GENERATION,
} from "../src/services/variationRefs.js";

beforeEach(() => {
  db.variationReference.findMany.mockReset();
  db.variationReference.groupBy.mockReset();
});

function refRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    presetId: "p1",
    brandName: "Betnella",
    assetKey: "email",
    imageUrl: `https://cdn/r${i}.png`,
    publicId: `bundle_refs/p1/betnella/${i}`,
    width: 1200,
    height: 600,
    sortOrder: i,
    createdAt: new Date(),
  }));
}

describe("pickGenerationRefs (DI-R3/R5)", () => {
  it(`бросает при < ${MIN_REFS_FOR_GENERATION} референсах`, async () => {
    db.variationReference.findMany.mockResolvedValue(refRows(4));
    await expect(pickGenerationRefs("p1", "Betnella", "email")).rejects.toThrow(
      "(формат email) 4 референсов, нужно >= 5",
    );
  });

  it("отдаёт все при 5..14", async () => {
    db.variationReference.findMany.mockResolvedValue(refRows(7));
    expect(await pickGenerationRefs("p1", "Betnella", "email")).toHaveLength(7);
  });

  it(`режет до ${MAX_EDIT_REFS} по порядку админа при 15 (лимит nano-banana-2 /edit)`, async () => {
    db.variationReference.findMany.mockResolvedValue(refRows(15));
    const picked = await pickGenerationRefs("p1", "Betnella", "email");
    expect(picked).toHaveLength(MAX_EDIT_REFS);
    expect(picked[0]!.id).toBe("r0");
    expect(picked.at(-1)!.id).toBe(`r${MAX_EDIT_REFS - 1}`);
  });
});

describe("refCountsByBrand (TASK multiformat-promo, DI2-2)", () => {
  it("групбай бренд×формат → вложенный словарь для бейджей мастера", async () => {
    db.variationReference.groupBy.mockResolvedValue([
      { brandName: "Betnella", assetKey: "email", _count: { _all: 7 } },
      { brandName: "Betnella", assetKey: "push", _count: { _all: 5 } },
      { brandName: "Corgi", assetKey: "email", _count: { _all: 2 } },
    ]);
    const counts = await refCountsByBrand("p1");
    expect(counts).toEqual({
      Betnella: { email: 7, push: 5 },
      Corgi: { email: 2 },
    });
    // countFor: отсутствующий формат = 0, а не undefined (гейт сравнивает с min).
    expect(countFor(counts, "Betnella", "push")).toBe(5);
    expect(countFor(counts, "Betnella", "popup")).toBe(0);
    expect(countFor(counts, "Unknown", "email")).toBe(0);
  });
});

describe("refsFolder", () => {
  it("папка Cloudinary разделена по формату — файлы форматов не смешиваются", () => {
    expect(refsFolder("p1", "Booongo(Monkey)", "push")).toBe(
      "bundle_refs/p1/booongo-monkey/push",
    );
  });
});

describe("brandSlug", () => {
  it("латиница/кириллица/скобки → безопасный слаг папки Cloudinary", () => {
    expect(brandSlug("Betnella")).toBe("betnella");
    expect(brandSlug("Booongo(Monkey)")).toBe("booongo-monkey");
    expect(brandSlug("Макаронка!")).toBe("макаронка");
    expect(brandSlug("***")).toBe("brand");
  });
});
