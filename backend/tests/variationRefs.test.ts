import { describe, it, expect, beforeEach, vi } from "vitest";

const db = vi.hoisted(() => ({
  variationReference: { findMany: vi.fn(), groupBy: vi.fn() },
}));
vi.mock("../src/lib/prisma.js", () => ({ prisma: db }));

import {
  pickGenerationRefs,
  refCountsByBrand,
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
    await expect(pickGenerationRefs("p1", "Betnella")).rejects.toThrow("нужно >= 5");
  });

  it("отдаёт все при 5..14", async () => {
    db.variationReference.findMany.mockResolvedValue(refRows(7));
    expect(await pickGenerationRefs("p1", "Betnella")).toHaveLength(7);
  });

  it(`режет до ${MAX_EDIT_REFS} по порядку админа при 15 (лимит nano-banana-2 /edit)`, async () => {
    db.variationReference.findMany.mockResolvedValue(refRows(15));
    const picked = await pickGenerationRefs("p1", "Betnella");
    expect(picked).toHaveLength(MAX_EDIT_REFS);
    expect(picked[0]!.id).toBe("r0");
    expect(picked.at(-1)!.id).toBe(`r${MAX_EDIT_REFS - 1}`);
  });
});

describe("refCountsByBrand", () => {
  it("групбай → словарь брендов для бейджей мастера", async () => {
    db.variationReference.groupBy.mockResolvedValue([
      { brandName: "Betnella", _count: { _all: 7 } },
      { brandName: "Corgi", _count: { _all: 2 } },
    ]);
    expect(await refCountsByBrand("p1")).toEqual({ Betnella: 7, Corgi: 2 });
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
