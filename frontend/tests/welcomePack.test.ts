import { describe, it, expect } from "vitest";
import {
  buildPackExportQuery,
  packFolderOf,
  sanitizeName,
  trailingIndexOf,
  splitBrandGender,
  packDisplayName,
  groupPackByElement,
  batchStatusLabel,
  batchCategoryLabel,
  visibleGenerations,
  packCounts,
  prettifyCategoryKey,
  exportableIds,
  replacePackImage,
  type WelPackBatch,
  type WelPackGeneration,
} from "~/composables/useWelcomePack";

/**
 * Result → "Welcome Pack" tab helpers. They mirror the tournament tab minus the
 * Base/VIP dimension: grouping is by element alone, and the batch title comes
 * from the (user-made) category key.
 */

function gen(over: Partial<WelPackGeneration> = {}): WelPackGeneration {
  return {
    id: "g1",
    status: "DONE",
    statusMessage: null,
    generatedImageUrl: "https://cdn/a.png",
    brandName: "Bonuskong",
    welCategoryKey: "welcome_series",
    welElementName: "Welcome_1",
    welFileName: "Bonuskong_Welcome_1_1",
    ...over,
  };
}

function batch(over: Partial<WelPackBatch> = {}): WelPackBatch {
  return {
    id: "b1",
    status: "COMPLETED",
    createdAt: "2026-08-18T10:00:00Z",
    generations: [gen()],
    ...over,
  };
}

describe("buildPackExportQuery", () => {
  it("an explicit selection wins over the batch", () => {
    expect(buildPackExportQuery({ batchId: "b1" })).toBe("batchId=b1");
    expect(buildPackExportQuery({ batchId: "b1", ids: ["g1", "g2"] })).toBe("ids=g1%2Cg2");
    expect(buildPackExportQuery({})).toBe("");
  });
});

describe("file-name helpers", () => {
  it("mirror the backend naming rules", () => {
    expect(packFolderOf("Bonuskong_Welcome_1_2")).toBe("Bonuskong_Welcome_1");
    expect(sanitizeName("Deposit & Bonus")).toBe("Deposit_&_Bonus");
    expect(sanitizeName("Spinogambino(Men)")).toBe("SpinogambinoMen");
    expect(trailingIndexOf("Bonuskong_Welcome_1_2")).toBe("2");
    expect(trailingIndexOf("no_index")).toBe("1");
  });

  it("splits the (Men)/(Women) suffix into the ZIP's gender suffix", () => {
    expect(splitBrandGender("Spinogambino(Men)")).toEqual({ base: "Spinogambino", gender: "men" });
    expect(splitBrandGender("Spinogambino (Women)")).toEqual({
      base: "Spinogambino",
      gender: "women",
    });
    expect(splitBrandGender("Bonuskong")).toEqual({ base: "Bonuskong", gender: "" });
  });
});

describe("packDisplayName", () => {
  it("captions a card with brand + element + index (+ gender)", () => {
    expect(packDisplayName(gen())).toBe("Bonuskong_Welcome_1_1");
    expect(
      packDisplayName(
        gen({
          brandName: "Spinogambino(Women)",
          welFileName: "SpinogambinoWomen_Welcome_2_3",
          welElementName: "Welcome_2",
        }),
      ),
    ).toBe("Spinogambino_Welcome_2_3_women");
  });

  it("falls back to the file name when the element name is missing", () => {
    // The fallback derives the element part from the file name, which already
    // starts with the brand — hence the doubled prefix. Same behaviour as the
    // tournament tab; in practice welElementName is always stored.
    expect(packDisplayName(gen({ welElementName: null }))).toBe("Bonuskong_Bonuskong_Welcome_1_1");
  });

  it("is empty for a row without a fixed file name", () => {
    expect(packDisplayName(gen({ welFileName: null }))).toBe("");
  });
});

describe("groupPackByElement", () => {
  it("groups by element in first-appearance order — no mode dimension", () => {
    const groups = groupPackByElement([
      gen({ id: "a", welElementName: "Welcome_1" }),
      gen({ id: "b", welElementName: "Welcome_2", welFileName: "Bonuskong_Welcome_2_1" }),
      gen({ id: "c", welElementName: "Welcome_1", welFileName: "Bonuskong_Welcome_1_2" }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["Welcome_1", "Welcome_2"]);
    expect(groups[0]!.images.map((i) => i.id)).toEqual(["a", "c"]);
    expect(groups[0]!.title).toBe("Welcome_1");
  });

  it("skips rows without a file name", () => {
    expect(groupPackByElement([gen({ welFileName: null })])).toEqual([]);
  });
});

describe("visibleGenerations / packCounts", () => {
  it("hides failed and cancelled rows and excludes them from the counters", () => {
    const b = batch({
      generations: [
        gen({ id: "ok" }),
        gen({ id: "bad", status: "FAILED", generatedImageUrl: null }),
        gen({ id: "gone", status: "CANCELLED", generatedImageUrl: null }),
        gen({ id: "run", status: "PROCESSING", generatedImageUrl: null }),
      ],
    });
    expect(visibleGenerations(b.generations).map((g) => g.id)).toEqual(["ok", "run"]);
    // "1 of 2", not "1 of 4" — the hidden failures must not skew the header.
    expect(packCounts(b)).toEqual({ done: 1, total: 2 });
  });
});

describe("batchStatusLabel", () => {
  it("reads a partial failure as done (failed rows are hidden anyway)", () => {
    expect(batchStatusLabel("IN_PROGRESS")).toBe("Генерация…");
    expect(batchStatusLabel("COMPLETED")).toBe("Готово");
    expect(batchStatusLabel("PARTIAL_FAILURE")).toBe("Готово");
    expect(batchStatusLabel("FAILED")).toBe("Ошибка");
    expect(batchStatusLabel("WEIRD")).toBe("WEIRD");
  });
});

describe("category labels", () => {
  it("prettifies a slug key back into a readable title", () => {
    expect(prettifyCategoryKey("welcome_series")).toBe("Welcome Series");
    expect(prettifyCategoryKey("calendar_vip")).toBe("Calendar VIP");
  });

  it("titles the batch by its category, joining distinct keys", () => {
    expect(batchCategoryLabel(batch())).toBe("Welcome Series");
    expect(
      batchCategoryLabel(
        batch({ generations: [gen(), gen({ id: "g2", welCategoryKey: "own_refs" })] }),
      ),
    ).toBe("Welcome Series + Own Refs");
  });

  it("falls back to 'Welcome' when the rows carry no category key", () => {
    expect(batchCategoryLabel(batch({ generations: [gen({ welCategoryKey: null })] }))).toBe(
      "Welcome",
    );
  });
});

describe("exportableIds", () => {
  it("only finished rows with a stored image can be exported", () => {
    const b = batch({
      generations: [
        gen({ id: "ok" }),
        gen({ id: "queued", status: "QUEUED", generatedImageUrl: null }),
        gen({ id: "noimg", status: "DONE", generatedImageUrl: null }),
      ],
    });
    expect(exportableIds([b])).toEqual(["ok"]);
  });
});

describe("replacePackImage", () => {
  it("swaps one image URL and leaves untouched batches identical", () => {
    const b1 = batch({ id: "b1", generations: [gen({ id: "g1" })] });
    const b2 = batch({ id: "b2", generations: [gen({ id: "g2" })] });
    const next = replacePackImage([b1, b2], "g1", "https://cdn/new.png");
    expect(next[0]!.generations[0]!.generatedImageUrl).toBe("https://cdn/new.png");
    expect(next[1]).toBe(b2); // identity preserved — no needless re-render
  });

  it("is a no-op for an unknown id", () => {
    const b = batch();
    const next = replacePackImage([b], "ghost", "https://cdn/new.png");
    expect(next[0]).toBe(b);
  });
});
