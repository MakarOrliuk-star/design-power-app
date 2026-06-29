import { describe, it, expect } from "vitest";
import {
  resolveModel,
  modelEndpoint,
  DEFAULT_MODEL_KEY,
  MODEL_OPTIONS,
} from "../src/lib/falModels.js";

describe("falModels registry", () => {
  it("resolves null/unknown keys to the default nano-banana-2 model", () => {
    expect(resolveModel(null).base).toBe("fal-ai/nano-banana-2");
    expect(resolveModel(undefined).base).toBe("fal-ai/nano-banana-2");
    expect(resolveModel("does-not-exist").base).toBe("fal-ai/nano-banana-2");
    expect(DEFAULT_MODEL_KEY).toBe("fal-ai/nano-banana-2");
  });

  it("picks the /edit endpoint only when reference images are present", () => {
    const nano = resolveModel(null);
    expect(modelEndpoint(nano, false)).toBe("fal-ai/nano-banana-2");
    expect(modelEndpoint(nano, true)).toBe("fal-ai/nano-banana-2/edit");

    const grok = resolveModel("xai/grok-imagine-image");
    expect(modelEndpoint(grok, false)).toBe("xai/grok-imagine-image");
    expect(modelEndpoint(grok, true)).toBe("xai/grok-imagine-image/edit");
  });

  it("nano body always carries a seed (Task 2), in both t2i and edit", () => {
    const nano = resolveModel(null);
    const t2i = nano.buildBody("p", [], "1:1");
    expect(typeof t2i.seed).toBe("number");
    expect(t2i.seed as number).toBeGreaterThanOrEqual(0);
    expect(t2i.seed as number).toBeLessThan(999999999);
    expect(t2i.image_urls).toBeUndefined();

    const edit = nano.buildBody("p", ["https://a.png"], "9:16");
    expect(typeof edit.seed).toBe("number");
    expect(edit.safety_tolerance).toBe("5");
    expect(edit.limit_generations).toBe(true);
    expect(edit.image_urls).toEqual(["https://a.png"]);
    expect(edit.resolution).toBe("1K");
  });

  it("grok body omits seed/safety_tolerance/limit_generations and uses lowercase resolution", () => {
    const grok = resolveModel("xai/grok-imagine-image");
    const body = grok.buildBody("p", ["a", "b", "c", "d"], "9:16");
    expect(body.seed).toBeUndefined();
    expect(body.safety_tolerance).toBeUndefined();
    expect(body.limit_generations).toBeUndefined();
    expect(body.resolution).toBe("1k");
    expect(body.output_format).toBe("png");
    // image_urls capped at 3 (model limit)
    expect(body.image_urls).toEqual(["a", "b", "c"]);
  });

  it("excludes the default model from the admin dropdown options", () => {
    expect(MODEL_OPTIONS.some((o) => o.key === DEFAULT_MODEL_KEY)).toBe(false);
    expect(MODEL_OPTIONS.some((o) => o.key === "xai/grok-imagine-image")).toBe(true);
  });
});
