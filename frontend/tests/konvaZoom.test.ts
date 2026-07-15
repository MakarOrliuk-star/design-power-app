import { describe, it, expect } from "vitest";
import {
  zoomAt,
  clampView,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_STEP,
  PAN_VISIBLE_MARGIN,
  type ViewTransform,
} from "~/composables/useKonvaZoom";

/**
 * FE Test — Konva viewport zoom (TASK Трек B). Pure math only: the cursor
 * anchor invariant, the min/max clamps and the "content stays reachable"
 * pan clamp. The composable's DOM wiring is exercised by hand (checklist).
 */

const VIEWPORT = { w: 600, h: 460 };

/** Screen position of a content point under a view transform. */
function toScreen(view: ViewTransform, cx: number, cy: number) {
  return { x: view.x + cx * view.scale, y: view.y + cy * view.scale };
}

describe("zoomAt", () => {
  it("keeps the content point under the cursor stationary", () => {
    const start: ViewTransform = { scale: 1, x: 0, y: 0 };
    const pointer = { x: 100, y: 200 };
    const zoomed = zoomAt(start, pointer, 1, VIEWPORT);

    expect(zoomed.scale).toBeCloseTo(ZOOM_STEP);
    // The content point that was under the cursor before…
    const cx = (pointer.x - start.x) / start.scale;
    const cy = (pointer.y - start.y) / start.scale;
    // …is still under the cursor after.
    expect(toScreen(zoomed, cx, cy).x).toBeCloseTo(pointer.x);
    expect(toScreen(zoomed, cx, cy).y).toBeCloseTo(pointer.y);
  });

  it("zoom out is the inverse direction and respects the anchor too", () => {
    const start: ViewTransform = { scale: 2, x: -50, y: -30 };
    const pointer = { x: 300, y: 230 };
    const out = zoomAt(start, pointer, -1, VIEWPORT);
    expect(out.scale).toBeCloseTo(2 / ZOOM_STEP);
    const cx = (pointer.x - start.x) / start.scale;
    const cy = (pointer.y - start.y) / start.scale;
    expect(toScreen(out, cx, cy).x).toBeCloseTo(pointer.x);
    expect(toScreen(out, cx, cy).y).toBeCloseTo(pointer.y);
  });

  it("clamps at ZOOM_MAX / ZOOM_MIN and returns the view unchanged at the edge", () => {
    const atMax: ViewTransform = { scale: ZOOM_MAX, x: 0, y: 0 };
    expect(zoomAt(atMax, { x: 10, y: 10 }, 1, VIEWPORT)).toBe(atMax);

    const atMin: ViewTransform = { scale: ZOOM_MIN, x: 0, y: 0 };
    expect(zoomAt(atMin, { x: 10, y: 10 }, -1, VIEWPORT)).toBe(atMin);

    // One step below the cap lands ON the cap, not past it.
    const near: ViewTransform = { scale: ZOOM_MAX / 1.01, x: 0, y: 0 };
    expect(zoomAt(near, { x: 0, y: 0 }, 1, VIEWPORT).scale).toBe(ZOOM_MAX);
  });
});

describe("clampView", () => {
  it("keeps at least the margin of content visible on every side", () => {
    // Dragged far right/down: the content's left-top edge may not pass
    // (viewport - margin).
    const far = clampView({ scale: 1, x: 5000, y: 5000 }, VIEWPORT);
    expect(far.x).toBe(VIEWPORT.w - PAN_VISIBLE_MARGIN);
    expect(far.y).toBe(VIEWPORT.h - PAN_VISIBLE_MARGIN);

    // Dragged far left/up: the content's right-bottom edge must stay reachable.
    const scale = 2;
    const gone = clampView({ scale, x: -5000, y: -5000 }, VIEWPORT);
    expect(gone.x).toBe(PAN_VISIBLE_MARGIN - VIEWPORT.w * scale);
    expect(gone.y).toBe(PAN_VISIBLE_MARGIN - VIEWPORT.h * scale);
  });

  it("returns the same object when already within bounds (no reactive churn)", () => {
    const v: ViewTransform = { scale: 1, x: 10, y: -10 };
    expect(clampView(v, VIEWPORT)).toBe(v);
  });
});
