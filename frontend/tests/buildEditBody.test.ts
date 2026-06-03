import { describe, it, expect } from "vitest";
import { buildEditBody } from "~/composables/useResult";
import { makeImage } from "./helpers";

/**
 * FE Test 4 — Edit request builder (TASK §5). The Result page sends a different
 * payload shape for ALL vs EACH and must block submission when a required prompt
 * is missing. This is the contract with POST /api/generate/edit.
 */
describe("buildEditBody", () => {
  const a = makeImage();
  const b = makeImage();

  it("ALL mode → one shared prompt for all selected ids", () => {
    const res = buildEditBody("ALL", [a, b], "  make it brighter  ", {});
    expect(res).toEqual({
      ok: true,
      body: { generationIds: [a.id, b.id], prompt: "make it brighter" }, // trimmed
    });
  });

  it("ALL mode → blocks an empty/whitespace shared prompt", () => {
    const res = buildEditBody("ALL", [a], "   ", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Введите промпт/);
  });

  it("EACH mode → per-image prompts map, trimmed and keyed by id", () => {
    const res = buildEditBody("EACH", [a, b], "", {
      [a.id]: " darker ",
      [b.id]: "add glow",
    });
    expect(res).toEqual({
      ok: true,
      body: { generationIds: [a.id, b.id], perPrompts: { [a.id]: "darker", [b.id]: "add glow" } },
    });
  });

  it("EACH mode → blocks when any selected image is missing its prompt", () => {
    const res = buildEditBody("EACH", [a, b], "", { [a.id]: "darker" }); // b missing
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/для каждой/);
  });

  it("returns the no_selection sentinel for an empty selection", () => {
    const res = buildEditBody("ALL", [], "anything", {});
    expect(res).toEqual({ ok: false, error: "no_selection" });
  });
});
