import { describe, it, expect, beforeEach, vi } from "vitest";

// ---- Mocks (hoisted so the processor's module graph picks them up) ----
const db = vi.hoisted(() => ({
  generationFindUnique: vi.fn(),
  generationUpdate: vi.fn(),
  jobUpdate: vi.fn(),
  brandFindUnique: vi.fn(),
  promptTemplateFindFirst: vi.fn(),
}));
const fal = vi.hoisted(() => ({
  runPersonFal: vi.fn(),
  runSeedvrUpscale: vi.fn(),
}));
const fin = vi.hoisted(() => ({
  finalizeSuccess: vi.fn(),
  finalizeFailure: vi.fn(),
}));

vi.mock("../src/env.js", () => ({
  personPipelineReady: true,
  itemPipelineReady: true,
  editPipelineReady: true,
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    generation: { findUnique: db.generationFindUnique, update: db.generationUpdate },
    job: { update: db.jobUpdate },
    brand: { findUnique: db.brandFindUnique },
    promptTemplate: { findFirst: db.promptTemplateFindFirst },
  },
}));
vi.mock("../src/lib/fal.js", () => ({
  runPersonFal: fal.runPersonFal,
  runSeedvrUpscale: fal.runSeedvrUpscale,
}));
vi.mock("../src/lib/cloudinary.js", () => ({
  uploadFromUrl: vi.fn(),
  withRetry: vi.fn(async (f: () => Promise<unknown>) => ({
    success: true,
    secure_url: "https://cdn/stored.png",
  })),
}));
vi.mock("../src/services/finalize.js", () => ({
  finalizeSuccess: fin.finalizeSuccess,
  finalizeFailure: fin.finalizeFailure,
}));

import { processItemJob } from "../src/queues/item.processor.js";

function genRow(over: Record<string, unknown> = {}) {
  return {
    brandName: "Bonuskong",
    description: "SYS[base prompt]\nkong style", // pre-built at batch creation
    referenceImages: ["https://cdn/ref1.png", "https://cdn/ref2.png"],
    isEdit: false,
    actionType: "TOURNAMENT",
    job: { id: "job1", cloudinaryFolder: "tournaments/tournament/2026-07-08" },
    ...over,
  };
}

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockReset();
  for (const fn of Object.values(fal)) fn.mockReset();
  for (const fn of Object.values(fin)) fn.mockReset();
  db.generationUpdate.mockResolvedValue({});
  db.jobUpdate.mockResolvedValue({});
  db.brandFindUnique.mockResolvedValue({ imageModel: null });
  fal.runPersonFal.mockResolvedValue({ success: true, imageUrl: "https://fal/out.png" });
  fal.runSeedvrUpscale.mockResolvedValue({ success: true, imageUrl: "https://fal/up.png" });
});

/**
 * QA — the item worker's TOURNAMENT branch: the prompt was fully assembled at
 * batch creation (system wrapper + element prompt + brand style), so the worker
 * must use it RAW — no second ITEM-template wrap — and must NOT run the
 * edit-only SeedVR upscale.
 */
describe("processItemJob — TOURNAMENT branch", () => {
  it("sends the pre-built prompt as-is and skips the upscale", async () => {
    db.generationFindUnique.mockResolvedValue(genRow());

    await processItemJob("gen1", "9:16");

    // Raw description straight to fal — buildItemPrompt was NOT consulted
    // (its PromptTemplate lookup never fires).
    expect(db.promptTemplateFindFirst).not.toHaveBeenCalled();
    expect(fal.runPersonFal).toHaveBeenCalledWith(
      "SYS[base prompt]\nkong style",
      ["https://cdn/ref1.png", "https://cdn/ref2.png"],
      "9:16",
      null,
    );
    expect(fal.runSeedvrUpscale).not.toHaveBeenCalled(); // edits only
    expect(fin.finalizeSuccess).toHaveBeenCalledWith("gen1", "https://cdn/stored.png");
  });

  it("ITEM rows still go through the style template (regression guard)", async () => {
    db.generationFindUnique.mockResolvedValue(
      genRow({ actionType: "CREATE_ITEM", brandName: "Neon", description: "a sword" }),
    );
    db.promptTemplateFindFirst.mockResolvedValue({ content: "wrap({{prompt}})" });

    await processItemJob("gen2");

    expect(fal.runPersonFal).toHaveBeenCalledWith(
      "wrap(a sword)",
      expect.any(Array),
      "1:1",
      null,
    );
  });

  it("edit rows keep their upscale (regression guard)", async () => {
    db.generationFindUnique.mockResolvedValue(
      genRow({ actionType: "CREATE_ITEM", isEdit: true, description: "make it darker" }),
    );

    await processItemJob("gen3");

    expect(fal.runPersonFal).toHaveBeenCalledWith(
      "make it darker",
      expect.any(Array),
      "1:1",
      null,
    );
    expect(fal.runSeedvrUpscale).toHaveBeenCalledTimes(1);
  });
});
