import { describe, it, expect, beforeEach, vi } from "vitest";

// ---- Mocks (hoisted so the service's module graph picks them up) ----
const db = vi.hoisted(() => ({
  brandFindMany: vi.fn(),
  elementFindMany: vi.fn(),
  overrideFindMany: vi.fn(),
  batchCreate: vi.fn(),
  generationCreate: vi.fn(),
  promptTemplateFindFirst: vi.fn(),
}));
const queue = vi.hoisted(() => ({ addBulk: vi.fn() }));

vi.mock("../src/env.js", () => ({
  personPipelineReady: true,
  itemPipelineReady: true,
  editPipelineReady: true,
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    brand: { findMany: db.brandFindMany },
    welcomeElement: { findMany: db.elementFindMany },
    userWelcomePromptOverride: { findMany: db.overrideFindMany },
    batch: { create: db.batchCreate },
    generation: { create: db.generationCreate },
    promptTemplate: { findFirst: db.promptTemplateFindFirst },
  },
}));
vi.mock("../src/queues/index.js", () => ({
  getPersonQueue: () => ({ addBulk: queue.addBulk }),
  getItemQueue: () => ({ addBulk: queue.addBulk }),
}));

import { createWelcomeBatches } from "../src/services/welcome.service.js";

const BRANDS = [
  {
    id: "b1",
    name: "Bonuskong",
    forcedAspectRatio: null,
    nanoRef: {
      referenceImages: ["https://cdn/b1-ref1.png", "https://cdn/b1-ref2.png", "https://cdn/b1-ref3.png"],
      stylePrompt: "kong style",
    },
  },
  {
    id: "b2",
    name: "Spinogambino(Men)",
    forcedAspectRatio: "9:16",
    nanoRef: { referenceImages: ["https://cdn/b2-ref1.png"], stylePrompt: "" },
  },
];

// e1: ordinary category (brand references). e2: a category flagged
// usesOwnReferences — the заказчик's checkbox, replacing the tournaments'
// hardcoded "provider" key.
const ELEMENTS = [
  {
    id: "e1",
    name: "Welcome_1",
    referenceImages: [],
    category: { key: "welcome_series", name: "Welcome Series", usesOwnReferences: false },
    prompt: { content: "welcome prompt" },
  },
  {
    id: "e2",
    name: "Deposit & Bonus",
    referenceImages: ["https://cdn/own-1.png", "https://cdn/own-2.png"],
    category: { key: "own_refs", name: "Own refs", usesOwnReferences: true },
    prompt: { content: "own-ref prompt" },
  },
];

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockReset();
  queue.addBulk.mockReset();
  db.brandFindMany.mockResolvedValue(BRANDS);
  db.elementFindMany.mockResolvedValue(ELEMENTS);
  db.overrideFindMany.mockResolvedValue([]);
  db.promptTemplateFindFirst.mockResolvedValue({ content: "SYS[{{prompt}}]" });
  let batchNo = 0;
  db.batchCreate.mockImplementation(async () => ({ id: `batch${++batchNo}` }));
  let genNo = 0;
  db.generationCreate.mockImplementation(async () => ({ id: `gen${++genNo}` }));
});

function baseParams(over: Record<string, unknown> = {}) {
  return {
    userId: "user1",
    brandIds: ["b1", "b2"],
    count: 2,
    selections: [{ elementId: "e1" }, { elementId: "e2" }],
    ...over,
  };
}

describe("createWelcomeBatches", () => {
  it("creates ONE batch per category and brand×element×count generations", async () => {
    const res = await createWelcomeBatches(baseParams());

    // 2 categories selected -> 2 batches; each: 2 brands × 1 element × 2 images.
    expect(db.batchCreate).toHaveBeenCalledTimes(2);
    expect(res).toEqual([
      { batchId: "batch1", categoryKey: "welcome_series", categoryName: "Welcome Series", count: 4 },
      { batchId: "batch2", categoryKey: "own_refs", categoryName: "Own refs", count: 4 },
    ]);
    expect(db.generationCreate).toHaveBeenCalledTimes(8);
    // One bulk enqueue for the whole run, one job per generation.
    expect(queue.addBulk).toHaveBeenCalledTimes(1);
    expect(queue.addBulk.mock.calls[0]![0]).toHaveLength(8);
  });

  it("batches carry actionType WELCOME so they never leak into the tournament tab", async () => {
    await createWelcomeBatches(baseParams({ count: 1 }));
    expect(db.batchCreate.mock.calls[0]![0].data.actionType).toBe("WELCOME");
    const rows = db.generationCreate.mock.calls.map((c) => c[0].data);
    expect(rows.every((r) => r.actionType === "WELCOME")).toBe(true);
    // The tournament columns stay untouched — separate features, separate columns.
    expect(rows.every((r) => r.tourCategoryKey === undefined)).toBe(true);
  });

  it("fixes naming, refs, prompt and metadata on each generation row", async () => {
    await createWelcomeBatches(baseParams());

    const rows = db.generationCreate.mock.calls.map((c) => c[0].data);
    const first = rows.find(
      (r) => r.brandName === "Bonuskong" && r.welElementName === "Welcome_1" && r.welFileName?.endsWith("_1"),
    )!;
    // Naming: {Brand}_{Element}_{N}, sanitized.
    expect(first.welFileName).toBe("Bonuskong_Welcome_1_1");
    expect(first.welCategoryKey).toBe("welcome_series");
    // Description = wrapped element prompt ONLY: the brand stylePrompt is
    // appended by the worker after the PERSON prompt-writer pass.
    expect(first.description).toBe("SYS[welcome prompt]");
    // Exactly TWO brand refs are mixed in (3rd is dropped).
    expect(first.referenceImages).toEqual(["https://cdn/b1-ref1.png", "https://cdn/b1-ref2.png"]);

    // Second image of the same brand×element bumps the suffix.
    const second = rows.find(
      (r) => r.brandName === "Bonuskong" && r.welElementName === "Welcome_1" && r.welFileName?.endsWith("_2"),
    )!;
    expect(second.welFileName).toBe("Bonuskong_Welcome_1_2");

    // Parentheses brand: sanitized in the file name, raw in brandName.
    const menRow = rows.find(
      (r) => r.brandName === "Spinogambino(Men)" && r.welCategoryKey === "welcome_series",
    )!;
    expect(menRow.welFileName).toMatch(/^SpinogambinoMen_Welcome_1_[12]$/);
  });

  it("a usesOwnReferences category takes the element's own images, not the brand's", async () => {
    await createWelcomeBatches(baseParams());

    const rows = db.generationCreate.mock.calls.map((c) => c[0].data);
    const own = rows.find((r) => r.welCategoryKey === "own_refs" && r.brandName === "Bonuskong")!;
    expect(own.referenceImages).toEqual(["https://cdn/own-1.png", "https://cdn/own-2.png"]);
    expect(own.welFileName).toMatch(/^Bonuskong_Deposit_&_Bonus_[12]$/);
    // Brand text style is NOT baked in — the worker appends it post prompt-writer.
    expect(own.description).toBe("SYS[own-ref prompt]");
  });

  it("turning the flag OFF falls back to brand refs while the images stay in the DB", async () => {
    // Same element, same stored referenceImages — only the category flag flipped.
    db.elementFindMany.mockResolvedValue([
      { ...ELEMENTS[1]!, category: { ...ELEMENTS[1]!.category, usesOwnReferences: false } },
    ]);
    await createWelcomeBatches(baseParams({ brandIds: ["b1"], count: 1, selections: [{ elementId: "e2" }] }));

    const rows = db.generationCreate.mock.calls.map((c) => c[0].data);
    expect(rows[0]!.referenceImages).toEqual(["https://cdn/b1-ref1.png", "https://cdn/b1-ref2.png"]);
  });

  it("a user's override replaces the default prompt for that element", async () => {
    db.overrideFindMany.mockResolvedValue([{ elementId: "e1", content: "MY custom prompt" }]);
    await createWelcomeBatches(baseParams());

    const rows = db.generationCreate.mock.calls.map((c) => c[0].data);
    expect(rows.find((r) => r.welCategoryKey === "welcome_series")!.description).toBe(
      "SYS[MY custom prompt]",
    );
    // The other element (no override) keeps the default.
    expect(rows.find((r) => r.welCategoryKey === "own_refs")!.description).toBe("SYS[own-ref prompt]");
  });

  it("the page aspect reaches the queued jobs; forcedAspectRatio still wins over it", async () => {
    await createWelcomeBatches(baseParams({ aspect: "9:16" }));
    const jobs = queue.addBulk.mock.calls[0]![0] as { data: { aspectRatio: string } }[];
    expect(new Set(jobs.map((j) => j.data.aspectRatio))).toEqual(new Set(["9:16"]));

    // The lock also wins when it CONFLICTS with the toggle: force 9:16 vs page 1:1.
    queue.addBulk.mockReset();
    db.brandFindMany.mockResolvedValue([BRANDS[1]!]);
    await createWelcomeBatches(
      baseParams({ aspect: "1:1", brandIds: ["b2"], selections: [{ elementId: "e1" }] }),
    );
    const locked = queue.addBulk.mock.calls[0]![0] as { data: { aspectRatio: string } }[];
    expect(new Set(locked.map((j) => j.data.aspectRatio))).toEqual(new Set(["9:16"]));
  });

  it("a brand without BrandNanoRef degrades to no refs (text-to-image path)", async () => {
    db.brandFindMany.mockResolvedValue([
      { id: "b3", name: "FreshBrand", forcedAspectRatio: null, nanoRef: null },
    ]);
    await createWelcomeBatches(
      baseParams({ brandIds: ["b3"], count: 1, selections: [{ elementId: "e1" }] }),
    );
    const rows = db.generationCreate.mock.calls.map((c) => c[0].data);
    expect(rows[0]!.referenceImages).toEqual([]);
    expect(rows[0]!.description).toBe("SYS[welcome prompt]");
  });

  it("rejects >4 brands, unknown elements and an element with no prompt", async () => {
    await expect(
      createWelcomeBatches(baseParams({ brandIds: ["1", "2", "3", "4", "5"] })),
    ).rejects.toThrow("too_many_brands");

    await expect(
      createWelcomeBatches(baseParams({ selections: [{ elementId: "ghost" }] })),
    ).rejects.toThrow("inactive_element");

    // A category built by hand can hold an element whose prompt was never written.
    db.elementFindMany.mockResolvedValue([{ ...ELEMENTS[0]!, prompt: null }]);
    await expect(
      createWelcomeBatches(baseParams({ selections: [{ elementId: "e1" }] })),
    ).rejects.toThrow("no_prompt");

    // Validation failures happen BEFORE any batch is created.
    expect(db.batchCreate).not.toHaveBeenCalled();
  });
});
