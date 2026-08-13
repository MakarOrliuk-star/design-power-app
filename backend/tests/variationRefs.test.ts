import { describe, it, expect, beforeEach, vi } from "vitest";

const db = vi.hoisted(() => ({
  variationReference: { findMany: vi.fn(), groupBy: vi.fn() },
}));
vi.mock("../src/lib/prisma.js", () => ({ prisma: db }));

import {
  pickGenerationRefs,
  refCountsByBrand,
  countFor,
  resolveRefPoolName,
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
    expect((await pickGenerationRefs("p1", "Betnella", "email")).refs).toHaveLength(7);
  });

  it(`режет до ${MAX_EDIT_REFS} по порядку админа при 15 (лимит nano-banana-2 /edit)`, async () => {
    db.variationReference.findMany.mockResolvedValue(refRows(15));
    const { refs } = await pickGenerationRefs("p1", "Betnella", "email");
    expect(refs).toHaveLength(MAX_EDIT_REFS);
    expect(refs[0]!.id).toBe("r0");
    expect(refs.at(-1)!.id).toBe(`r${MAX_EDIT_REFS - 1}`);
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

// Тон-варианты (TASK multiformat-promo, DI2-10): в ai_reference персонажа
// задают референсы, поэтому у (Men) и (Women) должны быть свои пулы — иначе
// пол героя в обоих комплектах случаен.
describe("resolveRefPoolName / фолбэк тона", () => {
  const counts = {
    Betnella: { email: 8, push: 7 },
    "Betnella(Men)": { email: 6 },
    "Betnella(Women)": { email: 2 },
  };

  it("свой непустой пул варианта побеждает общий", () => {
    expect(resolveRefPoolName(counts, "Betnella(Men)", "Betnella", "email")).toEqual({
      poolName: "Betnella(Men)",
      count: 6,
    });
  });

  it("пустой пул варианта наследует общий пул бренда", () => {
    expect(resolveRefPoolName(counts, "Betnella(Men)", "Betnella", "push")).toEqual({
      poolName: "Betnella",
      count: 7,
    });
  });

  it("начатый, но недобранный пул НЕ подменяется общим (иначе смесь полов молча)", () => {
    expect(resolveRefPoolName(counts, "Betnella(Women)", "Betnella", "email")).toEqual({
      poolName: "Betnella(Women)",
      count: 2,
    });
  });

  it("бренд без тон-вариантов работает как раньше", () => {
    expect(resolveRefPoolName(counts, "Betnella", "Betnella", "email")).toEqual({
      poolName: "Betnella",
      count: 8,
    });
  });
});

describe("pickGenerationRefs — фолбэк на общий пул (DI2-10)", () => {
  it("пул варианта пуст → читаем общий пул базового бренда", async () => {
    db.variationReference.findMany
      .mockResolvedValueOnce([]) // Betnella(Men)
      .mockResolvedValueOnce(refRows(6)); // Betnella
    const picked = await pickGenerationRefs("p1", "Betnella(Men)", "email", "Betnella");
    expect(picked.refs).toHaveLength(6);
    // Правка 2026-08-13: вызывающий должен УЗНАТЬ о фолбэке — общий пул
    // смешан по полу, и для варианта «(Men)» это повод предупредить админа.
    expect(picked.poolName).toBe("Betnella");
    expect(picked.fellBackToBase).toBe(true);
    expect(db.variationReference.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { presetId: "p1", brandName: "Betnella", assetKey: "email" },
      }),
    );
  });

  it("у варианта свои референсы → общий пул не читается вовсе", async () => {
    db.variationReference.findMany.mockResolvedValue(refRows(7));
    const picked = await pickGenerationRefs("p1", "Betnella(Men)", "email", "Betnella");
    expect(db.variationReference.findMany).toHaveBeenCalledTimes(1);
    expect(picked.fellBackToBase).toBe(false);
    expect(picked.poolName).toBe("Betnella(Men)");
  });

  it("в ошибке назван пул, который реально проверяли", async () => {
    db.variationReference.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce(refRows(3));
    await expect(pickGenerationRefs("p1", "Betnella(Men)", "push", "Betnella")).rejects.toThrow(
      'у бренда "Betnella" (формат push) 3 референсов',
    );
  });
});

describe("refsFolder", () => {
  it("новые форматы уходят в свои подпапки — public_id по форматам не совпадают", () => {
    expect(refsFolder("p1", "Booongo(Monkey)", "push")).toBe("bundle_refs/p1/booongo-monkey/push");
    expect(refsFolder("p1", "Betnella", "popup")).toBe("bundle_refs/p1/betnella/popup");
  });

  it("email сохраняет исторический путь — дедуп по publicId продолжает работать", () => {
    expect(refsFolder("p1", "Betnella", "email")).toBe("bundle_refs/p1/betnella");
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
