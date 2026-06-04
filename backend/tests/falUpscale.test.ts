import { describe, it, expect, vi, afterEach } from "vitest";

// env.ts validates process.env + calls process.exit() at import — mock it so the
// fal client can be imported in isolation. authHeaders() reads env.FAL_KEY.
vi.mock("../src/env.js", () => ({ env: { FAL_KEY: "test-key" } }));

import { runSeedvrUpscale, extractFalImageUrl } from "../src/lib/fal.js";

function okResponse(bodyObj: unknown) {
  return { status: 200, text: async () => JSON.stringify(bodyObj) } as unknown as Response;
}

describe("runSeedvrUpscale", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts image_url to the SeedVR endpoint and returns the upscaled url", async () => {
    const fetchMock = vi.fn(async () => okResponse({ image: { url: "https://up/out.png" }, seed: 7 }));
    vi.stubGlobal("fetch", fetchMock);

    const r = await runSeedvrUpscale("https://src/in.png", 2);

    expect(r).toEqual({ success: true, imageUrl: "https://up/out.png" });
    const [url, opts] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("https://fal.run/fal-ai/seedvr/upscale/image");
    const body = JSON.parse(opts.body);
    expect(body.image_url).toBe("https://src/in.png");
    expect(body.upscale_mode).toBe("factor");
    expect(body.upscale_factor).toBe(2);
    expect(body.output_format).toBe("png");
  });

  it("fails fast on an empty url without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const r = await runSeedvrUpscale("");

    expect(r.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("extractFalImageUrl understands the SeedVR {image:{url}} response shape", () => {
    expect(extractFalImageUrl({ image: { url: "https://a.png" }, seed: 1 })).toBe("https://a.png");
  });
});
