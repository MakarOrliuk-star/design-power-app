import { describe, it, expect } from "vitest";
import {
  messageFor,
  previewPersonBox,
  stencilCircles,
  stencilGuides,
} from "~/stores/game";
import type { GameTemplateSpec } from "~/types/game";

/**
 * FE Test — the preview must agree with the renderer (TASK game-manager,
 * Phase 2). These are the same assertions as backend/tests/gameCompose.test.ts,
 * expressed in the preview's fractional units: if the two ever drift, a
 * designer sees one layout on screen and gets another one out of Save.
 */

const spec: GameTemplateSpec = {
  person: {
    centerX: 0.5,
    centerY: 0.5,
    outerRadius: 0.5,
    innerRadius: 0.375,
    fitCircle: "outer",
  },
};
const W = 1080;
const H = 1920;

describe("stencilGuides", () => {
  it("puts the vertical guides on the inner circle's tangents", () => {
    expect(stencilGuides(spec, W, H).vertical).toEqual([0.125, 0.5, 0.875]);
  });

  it("puts the horizontal guides on the outer circle's tangents", () => {
    const { horizontal } = stencilGuides(spec, W, H);
    expect(horizontal[0]).toBeCloseTo(0.21875, 6);
    expect(horizontal[1]).toBe(0.5);
    expect(horizontal[2]).toBeCloseTo(0.78125, 6);
  });

  it("reproduces the Figma percentages on the mock's own 487x811 box", () => {
    // The measured mock: verticals at 12.4% / 87.6%, horizontals at 19.9% / 80%.
    const { vertical, horizontal } = stencilGuides(spec, 487, 811);
    expect(vertical[0] * 100).toBeCloseTo(12.5, 1);
    expect(horizontal[0] * 100).toBeCloseTo(20.0, 1);
    expect(horizontal[2] * 100).toBeCloseTo(80.0, 1);
  });
});

describe("stencilCircles", () => {
  it("keeps circles round on the real canvas: rx in width, ry in height", () => {
    const { outer, inner } = stencilCircles(spec, W, H);
    expect(outer.rx).toBe(0.5);
    expect(outer.ry).toBeCloseTo(0.28125, 6);
    // Same physical radius → rx*W must equal ry*H
    expect(outer.rx * W).toBeCloseTo(outer.ry * H, 6);
    expect(inner.rx * W).toBeCloseTo(inner.ry * H, 6);
  });

  it("keeps the measured ¾ ratio between the circles", () => {
    const { outer, inner } = stencilCircles(spec, W, H);
    expect(inner.rx / outer.rx).toBeCloseTo(0.75, 6);
  });
});

describe("previewPersonBox", () => {
  it("fills the canvas width for a square person at 100%", () => {
    const box = previewPersonBox(spec, 500, 500, W, H, 1);
    expect(box.width).toBeCloseTo(1, 6); // 100% of the box width
    expect(box.left).toBeCloseTo(0, 6);
  });

  it("agrees with the backend for a tall person (2:1 → half width)", () => {
    const box = previewPersonBox(spec, 400, 800, W, H, 1);
    // backend: width = W/2 px → 0.5 of the box; height = W px → W/H of the box
    expect(box.width).toBeCloseTo(0.5, 6);
    expect(box.height).toBeCloseTo(W / H, 6);
  });

  it("stays centred at every scale", () => {
    for (const scale of [0.5, 1, 1.5]) {
      const box = previewPersonBox(spec, 300, 600, W, H, scale);
      expect(box.left + box.width / 2).toBeCloseTo(0.5, 6);
      expect(box.top + box.height / 2).toBeCloseTo(0.5, 6);
    }
  });

  it("scales linearly with the slider", () => {
    const half = previewPersonBox(spec, 400, 400, W, H, 0.5);
    const full = previewPersonBox(spec, 400, 400, W, H, 1);
    expect(half.width * 2).toBeCloseTo(full.width, 6);
  });

  it("honours a spec that fits to the inner circle", () => {
    const inner = previewPersonBox(
      { person: { ...spec.person, fitCircle: "inner" } },
      400,
      400,
      W,
      H,
      1,
    );
    expect(inner.width).toBeCloseTo(0.75, 6);
  });
});

describe("messageFor", () => {
  it("translates known backend codes", () => {
    expect(messageFor("no_layers", "x")).toBe("Выберите фон или персонажа.");
    expect(messageFor("no_images_in_archive", "x")).toContain("нет картинок");
  });

  it("falls back for unknown or missing codes", () => {
    expect(messageFor("something_new", "запасной")).toBe("запасной");
    expect(messageFor(null, "запасной")).toBe("запасной");
    expect(messageFor(undefined, "запасной")).toBe("запасной");
  });
});
