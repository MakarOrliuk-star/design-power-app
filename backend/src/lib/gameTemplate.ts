/**
 * The Game stencil ("трафарет") — TASK game-manager, Phase 2, Q6: one template
 * for everything.
 *
 * The geometry was measured off the Figma export, not eyeballed
 * (figma/game manager page/макаронка 2.0 — Game manager.png, 2880×1305 = the
 * 1920 design at 1.5x). The preview box there is 487×811 device px and the
 * guides land on:
 *
 *   vertical   x = 12.4% and 87.6%    horizontal y = 20.0% and 80.0%
 *   outer circle  cy ± 243.5 px       inner circle  cx ± 182.5 px
 *
 * Those four numbers are one shape, not four: 243.5 = half the box width and
 * 182.5 = ¾ of that. So the stencil is two concentric circles on the canvas
 * centre — the outer one spanning the full width, the inner one at ¾ of it —
 * and the guides are simply their tangents. Everything below is therefore
 * expressed as a fraction of the canvas WIDTH, which is what lets the same
 * template drive any output size.
 *
 * The canvas itself is 9:16 (Q7). The mock's preview box is 3:5; that is a
 * drawing-board approximation, and the circles — being width-derived — carry
 * over unchanged.
 */

export interface GameTemplateSpec {
  person: {
    /** Circle centre, as a fraction of canvas width / height. */
    centerX: number;
    centerY: number;
    /** Outer guide circle radius, as a fraction of canvas WIDTH. */
    outerRadius: number;
    /** Inner (tight) guide circle radius, same unit. */
    innerRadius: number;
    /** Which circle the person is fitted to at scale = 1. */
    fitCircle: "outer" | "inner";
  };
}

export const DEFAULT_TEMPLATE_KEY = "game-default";

/** 9:16 (Q7). 1080×1920 is the standard story canvas. */
export const DEFAULT_CANVAS = { width: 1080, height: 1920 } as const;

export const DEFAULT_TEMPLATE_SPEC: GameTemplateSpec = {
  person: {
    centerX: 0.5,
    centerY: 0.5,
    outerRadius: 0.5, // 243.5 / 487 — spans the full canvas width
    innerRadius: 0.375, // 182.5 / 487 — exactly ¾ of the outer circle
    fitCircle: "outer",
  },
};

/**
 * Guide positions for the preview overlay, as fractions of the canvas box.
 * Derived — never hard-coded — so the UI and the renderer can't disagree.
 */
export function guideLines(
  spec: GameTemplateSpec,
  canvasW: number,
  canvasH: number,
): { vertical: number[]; horizontal: number[] } {
  const { centerX, centerY, innerRadius, outerRadius } = spec.person;
  // Vertical guides are tangent to the INNER circle, horizontal ones to the
  // OUTER circle — that is what the mock shows, and it falls out of the radii.
  const dx = innerRadius; // fraction of width
  const dy = (outerRadius * canvasW) / canvasH; // width-relative → height-relative
  return {
    vertical: [centerX - dx, centerX, centerX + dx],
    horizontal: [centerY - dy, centerY, centerY + dy],
  };
}

/** Parse a spec stored as JSON, falling back to the measured default. */
export function parseTemplateSpec(value: unknown): GameTemplateSpec {
  const p = (value as { person?: Record<string, unknown> } | null)?.person;
  if (!p) return DEFAULT_TEMPLATE_SPEC;
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const d = DEFAULT_TEMPLATE_SPEC.person;
  return {
    person: {
      centerX: num(p.centerX, d.centerX),
      centerY: num(p.centerY, d.centerY),
      outerRadius: num(p.outerRadius, d.outerRadius),
      innerRadius: num(p.innerRadius, d.innerRadius),
      fitCircle: p.fitCircle === "inner" ? "inner" : "outer",
    },
  };
}
