import { describe, it, expect, vi } from "vitest";

// env.ts validates process.env at import — mock the bits cloudinary.ts reads.
vi.mock("../src/env.js", () => ({
  env: { CLOUDINARY_CLOUD_NAME: "testcloud", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s" },
}));

import { composeLayersUrl } from "../src/lib/cloudinary.js";

/**
 * BE Test — deterministic layer compositor URL (Image Bundles layered mode,
 * D10 v2): cutouts are fit into their zone boxes and applied over the base;
 * public-id folders use ":" in layer references per Cloudinary syntax.
 */
describe("composeLayersUrl", () => {
  it("builds the chained overlay URL with c_fit boxes and gravity placement", () => {
    const url = composeLayersUrl("bundles/bun1/bg", [
      { publicId: "bundles/bun1/cut_item", w: 284, h: 584, gravity: "west", x: 8, y: 0 },
      { publicId: "bundles/bun1/cut_person", w: 284, h: 584, gravity: "south_east", x: 8, y: 0 },
    ]);
    expect(url).toBe(
      "https://res.cloudinary.com/testcloud/image/upload/" +
        "l_bundles:bun1:cut_item,c_fit,w_284,h_584/fl_layer_apply,g_west,x_8,y_0/" +
        "l_bundles:bun1:cut_person,c_fit,w_284,h_584/fl_layer_apply,g_south_east,x_8,y_0/" +
        "bundles/bun1/bg.png",
    );
  });

  it("works with no layers (base passthrough)", () => {
    const url = composeLayersUrl("bundles/x/bg", []);
    expect(url).toBe("https://res.cloudinary.com/testcloud/image/upload/bundles/x/bg.png");
  });
});
