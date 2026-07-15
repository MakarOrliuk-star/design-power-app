import { describe, it, expect, beforeEach, vi } from "vitest";

// ---- Mocks (hoisted so the service's module graph picks them up) ----
const db = vi.hoisted(() => ({
  brandFindMany: vi.fn(),
  elementFindMany: vi.fn(),
  overrideFindMany: vi.fn(),
  batchCreate: vi.fn(),
  generationCreate: vi.fn(),
  promptTemplateFindFirst: vi.fn(),
  desCounterCreateMany: vi.fn(),
  queryRaw: vi.fn(),
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
    tournamentElement: { findMany: db.elementFindMany },
    userTournamentPromptOverride: { findMany: db.overrideFindMany },
    batch: { create: db.batchCreate },
    generation: { create: db.generationCreate },
    promptTemplate: { findFirst: db.promptTemplateFindFirst },
    desCounter: { createMany: db.desCounterCreateMany },
    $queryRaw: db.queryRaw,
  },
}));
vi.mock("../src/queues/index.js", () => ({
  getPersonQueue: () => ({ addBulk: queue.addBulk }),
  getItemQueue: () => ({ addBulk: queue.addBulk }),
}));

import {
  sanitizeName,
  buildTournamentPrompt,
  nextDesNumber,
  createTournamentBatches,
} from "../src/services/tournament.service.js";

/**
 * Tournament naming (Phase 0 decision): parentheses dropped, spaces -> "_",
 * everything else ("&" included) kept as-is.
 */
describe("sanitizeName", () => {
  it("drops parentheses and turns spaces into underscores", () => {
    expect(sanitizeName("Spinogambino(Men)")).toBe("SpinogambinoMen");
    expect(sanitizeName("Playson & Booongo")).toBe("Playson_&_Booongo");
    expect(sanitizeName("Tournament Halloween")).toBe("Tournament_Halloween");
    expect(sanitizeName("Tournament_1")).toBe("Tournament_1");
  });
});

describe("buildTournamentPrompt", () => {
  it("injects the element prompt at {{prompt}} and appends the brand style", () => {
    expect(buildTournamentPrompt("SYS[{{prompt}}]", "druid in forest", "neon style")).toBe(
      "SYS[druid in forest]\nneon style",
    );
  });
  it("appends when the wrapper has no placeholder; identity without a wrapper", () => {
    expect(buildTournamentPrompt("SYS", "druid", "")).toBe("SYS\ndruid");
    expect(buildTournamentPrompt("", "druid", "")).toBe("druid");
  });
});

describe("nextDesNumber", () => {
  it("returns the atomically incremented counter value", async () => {
    db.queryRaw.mockResolvedValue([{ value: 100001 }]);
    expect(await nextDesNumber()).toBe(100001);
  });
  it("self-seeds the counter on an unseeded DB and retries (first number = 100001)", async () => {
    db.queryRaw
      .mockResolvedValueOnce([]) // row missing
      .mockResolvedValueOnce([{ value: 100001 }]); // after createMany
    db.desCounterCreateMany.mockResolvedValue({ count: 1 });
    expect(await nextDesNumber()).toBe(100001);
    expect(db.desCounterCreateMany).toHaveBeenCalledWith({
      data: [{ id: 1, value: 100000 }],
      skipDuplicates: true,
    });
  });

  it("throws only if the row is still missing after self-seed", async () => {
    db.queryRaw.mockResolvedValue([]);
    db.desCounterCreateMany.mockResolvedValue({ count: 0 });
    await expect(nextDesNumber()).rejects.toThrow("des_counter_missing");
  });
});

// ---- createTournamentBatches ----

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

const ELEMENTS = [
  {
    id: "e1",
    name: "Tournament_1",
    referenceImages: [],
    category: { key: "tournament", hasModes: true, fixedMode: null },
    prompts: [
      { mode: "BASE", content: "base tournament prompt" },
      { mode: "VIP", content: "vip tournament prompt" },
    ],
  },
  {
    id: "e2",
    name: "Playson & Booongo",
    referenceImages: ["https://cdn/prov-1.png", "https://cdn/prov-2.png"],
    category: { key: "provider", hasModes: false, fixedMode: "BASE" },
    prompts: [{ mode: "BASE", content: "provider prompt" }],
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
    selections: [
      { elementId: "e1", mode: "BASE" as const },
      { elementId: "e2" },
    ],
    ...over,
  };
}

describe("createTournamentBatches", () => {
  it("creates ONE batch per category and brand×element×count generations", async () => {
    const res = await createTournamentBatches(baseParams());

    // 2 categories selected -> 2 batches; each: 2 brands × 1 element × 2 images.
    expect(db.batchCreate).toHaveBeenCalledTimes(2);
    expect(res).toEqual([
      { batchId: "batch1", categoryKey: "tournament", count: 4 },
      { batchId: "batch2", categoryKey: "provider", count: 4 },
    ]);
    expect(db.generationCreate).toHaveBeenCalledTimes(8);
    // One bulk enqueue for the whole run, one job per generation.
    expect(queue.addBulk).toHaveBeenCalledTimes(1);
    expect(queue.addBulk.mock.calls[0]![0]).toHaveLength(8);
  });

  it("fixes naming, refs, prompt and metadata on each generation row", async () => {
    await createTournamentBatches(baseParams());

    const rows = db.generationCreate.mock.calls.map((c) => c[0].data);
    const first = rows.find(
      (r) => r.brandName === "Bonuskong" && r.tourElementName === "Tournament_1" && r.tourFileName?.endsWith("_1"),
    )!;
    // Naming: {Brand}_{Element}_{N}, sanitized.
    expect(first.tourFileName).toBe("Bonuskong_Tournament_1_1");
    expect(first.tourCategoryKey).toBe("tournament");
    expect(first.tourMode).toBe("BASE");
    expect(first.actionType).toBe("TOURNAMENT");
    // Description = wrapped element prompt ONLY: the brand stylePrompt is
    // appended by the worker after the PERSON prompt-writer pass.
    expect(first.description).toBe("SYS[base tournament prompt]");
    // Exactly TWO brand refs are mixed in (3rd is dropped).
    expect(first.referenceImages).toEqual(["https://cdn/b1-ref1.png", "https://cdn/b1-ref2.png"]);

    // Second image of the same brand×element bumps the suffix.
    const second = rows.find(
      (r) => r.brandName === "Bonuskong" && r.tourElementName === "Tournament_1" && r.tourFileName?.endsWith("_2"),
    )!;
    expect(second.tourFileName).toBe("Bonuskong_Tournament_1_2");

    // Parentheses brand: sanitized in the file name, raw in brandName.
    const menRow = rows.find(
      (r) => r.brandName === "Spinogambino(Men)" && r.tourCategoryKey === "tournament",
    )!;
    expect(menRow.tourFileName).toMatch(/^SpinogambinoMen_Tournament_1_[12]$/);
  });

  it("provider elements use the provider's admin refs, not the brand images", async () => {
    await createTournamentBatches(baseParams());

    const rows = db.generationCreate.mock.calls.map((c) => c[0].data);
    const prov = rows.find((r) => r.tourCategoryKey === "provider" && r.brandName === "Bonuskong")!;
    expect(prov.referenceImages).toEqual(["https://cdn/prov-1.png", "https://cdn/prov-2.png"]);
    // fixedMode category resolves BASE without a client-sent mode.
    expect(prov.tourMode).toBe("BASE");
    expect(prov.tourFileName).toMatch(/^Bonuskong_Playson_&_Booongo_[12]$/);
    // Brand text style is NOT baked in — the worker appends it post prompt-writer.
    expect(prov.description).toBe("SYS[provider prompt]");
  });

  it("a user's override replaces the default prompt for that element+mode", async () => {
    db.overrideFindMany.mockResolvedValue([
      { elementId: "e1", mode: "BASE", content: "MY custom prompt" },
    ]);
    await createTournamentBatches(baseParams());

    const rows = db.generationCreate.mock.calls.map((c) => c[0].data);
    const t = rows.find((r) => r.tourCategoryKey === "tournament")!;
    expect(t.description).toBe("SYS[MY custom prompt]");
    // The provider element (no override) keeps the default.
    const prov = rows.find((r) => r.tourCategoryKey === "provider")!;
    expect(prov.description).toBe("SYS[provider prompt]");
  });

  it("forcedAspectRatio wins over the 1:1 default in the queued jobs", async () => {
    await createTournamentBatches(baseParams());
    const jobs = queue.addBulk.mock.calls[0]![0] as { data: { aspectRatio: string } }[];
    const aspects = new Set(jobs.map((j) => j.data.aspectRatio));
    expect(aspects).toEqual(new Set(["1:1", "9:16"]));
  });

  it("the page aspect reaches the queued jobs; forcedAspectRatio still wins over it", async () => {
    await createTournamentBatches(baseParams({ aspect: "9:16" }));
    // b1 (no force) follows the page toggle; b2 keeps its own 9:16 force.
    const jobs = queue.addBulk.mock.calls[0]![0] as { data: { aspectRatio: string } }[];
    expect(new Set(jobs.map((j) => j.data.aspectRatio))).toEqual(new Set(["9:16"]));

    // The lock also wins when it CONFLICTS with the toggle: force 9:16 vs page 1:1.
    queue.addBulk.mockReset();
    db.brandFindMany.mockResolvedValue([BRANDS[1]!]); // only the locked brand
    await createTournamentBatches(
      baseParams({ aspect: "1:1", brandIds: ["b2"], selections: [{ elementId: "e1", mode: "BASE" }] }),
    );
    const locked = queue.addBulk.mock.calls[0]![0] as { data: { aspectRatio: string } }[];
    expect(new Set(locked.map((j) => j.data.aspectRatio))).toEqual(new Set(["9:16"]));
  });

  it("a provider with only ONE admin ref still generates (uses what exists)", async () => {
    db.elementFindMany.mockResolvedValue([
      { ...ELEMENTS[1]!, referenceImages: ["https://cdn/prov-only.png"] },
    ]);
    await createTournamentBatches(baseParams({ selections: [{ elementId: "e2" }] }));
    const rows = db.generationCreate.mock.calls.map((c) => c[0].data);
    expect(rows[0]!.referenceImages).toEqual(["https://cdn/prov-only.png"]);
  });

  it("a brand without BrandNanoRef degrades to no refs (text-to-image path)", async () => {
    db.brandFindMany.mockResolvedValue([
      { id: "b3", name: "FreshBrand", forcedAspectRatio: null, nanoRef: null },
    ]);
    await createTournamentBatches(
      baseParams({ brandIds: ["b3"], selections: [{ elementId: "e1", mode: "BASE" }] }),
    );
    const rows = db.generationCreate.mock.calls.map((c) => c[0].data);
    expect(rows[0]!.referenceImages).toEqual([]);
    // No stylePrompt either — the prompt is just the wrapped element prompt.
    expect(rows[0]!.description).toBe("SYS[base tournament prompt]");
  });

  it("rejects >4 brands, unknown elements, and a missing mode for a moded category", async () => {
    await expect(
      createTournamentBatches(baseParams({ brandIds: ["1", "2", "3", "4", "5"] })),
    ).rejects.toThrow("too_many_brands");

    await expect(
      createTournamentBatches(baseParams({ selections: [{ elementId: "ghost" }] })),
    ).rejects.toThrow("inactive_element");

    await expect(
      createTournamentBatches(baseParams({ selections: [{ elementId: "e1" }] })),
    ).rejects.toThrow("invalid_mode");

    // Validation failures happen BEFORE any batch is created.
    expect(db.batchCreate).not.toHaveBeenCalled();
  });
});
