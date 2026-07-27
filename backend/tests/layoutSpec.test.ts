import { describe, it, expect, beforeEach, vi } from "vitest";

// Unit tests for the layout-spec schema, the email.hero.v1 calibration and the
// versioned DB helpers (TASK email-composition, Phase 1).
const db = vi.hoisted(() => ({
  layoutSpec: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
  },
}));
vi.mock("../src/lib/prisma.js", () => ({ prisma: db }));

import {
  layoutSpecSchema,
  validateLayoutSpec,
  EMAIL_HERO_V1,
  EMAIL_HERO_KEY,
  createLayoutSpecVersion,
  getActiveLayoutSpec,
  getLayoutSpecVersion,
} from "../src/services/layoutSpec.js";

beforeEach(() => {
  for (const fn of Object.values(db.layoutSpec)) fn.mockReset();
});

// ------------------------------------------------------------------
// Calibration: pixel-scan of `figma/crm-bundle/example email with text.PNG`
// (1325×664, measured 2026-07-27). The spec must agree with the reference
// within tolerance — this is the Phase 1 DoD check.
// ------------------------------------------------------------------
const MEASURED = {
  item: { left: 0.026, right: 0.24, top: 0.3 },
  person: { left: 0.749, right: 0.998, top: 0.12 },
  baseline: 0.92, // common ground line both subjects stand on
};
const TOL = 0.03;

describe("email.hero.v1 calibration vs reference measurements", () => {
  const spec = EMAIL_HERO_V1;

  it("passes its own runtime schema", () => {
    expect(() => validateLayoutSpec(spec)).not.toThrow();
  });

  it("uses the canonical email canvas with retina scale (D-E2)", () => {
    expect(spec.canvas).toEqual({ w: 1200, h: 600, scales: [1, 2] });
  });

  it("item zone covers the measured item cluster", () => {
    const z = spec.subjects.item.zone;
    expect(z.x).toBeLessThanOrEqual(MEASURED.item.left);
    expect(z.x + z.w).toBeGreaterThanOrEqual(MEASURED.item.right);
    expect(z.x + z.w).toBeCloseTo(0.25, 5); // mask boundary
  });

  it("person zone starts at the measured character edge (mask 75%)", () => {
    const z = spec.subjects.person.zone;
    expect(Math.abs(z.x - MEASURED.person.left)).toBeLessThanOrEqual(0.01);
    expect(z.x + z.w).toBeCloseTo(1, 5); // pressed to the right edge
  });

  it("baseline matches the measured ground line", () => {
    expect(Math.abs(spec.baseline - MEASURED.baseline)).toBeLessThanOrEqual(0.02);
  });

  it("fit heights derive from measured top edges and the baseline", () => {
    const itemH = MEASURED.baseline - MEASURED.item.top; // ≈0.62
    const personH = MEASURED.baseline - MEASURED.person.top; // ≈0.80
    expect(Math.abs(spec.subjects.item.fitHeight.target - itemH)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(spec.subjects.person.fitHeight.target - personH)).toBeLessThanOrEqual(TOL);
  });

  it("safe zone is the central mask section with core text envelopes inside", () => {
    const safe = spec.safe!;
    expect(safe.zone.x).toBeCloseTo(0.25, 5);
    expect(safe.zone.w).toBeCloseTo(0.5, 5);
    expect(safe.coreRects.length).toBeGreaterThanOrEqual(3); // UP TO / offer / CTA
    for (const core of safe.coreRects) {
      expect(core.x).toBeGreaterThanOrEqual(safe.zone.x);
      expect(core.x + core.w).toBeLessThanOrEqual(safe.zone.x + safe.zone.w + 1e-9);
      expect(core.y).toBeGreaterThanOrEqual(safe.zone.y);
      expect(core.y + core.h).toBeLessThanOrEqual(safe.zone.y + safe.zone.h + 1e-9);
    }
  });

  it("subjects never overlap the safe zone (zones + overflow stay outside)", () => {
    const safe = spec.safe!;
    const item = spec.subjects.item;
    const person = spec.subjects.person;
    expect(item.zone.x + item.zone.w + item.overflow.right).toBeLessThanOrEqual(safe.zone.x + 1e-9);
    expect(person.zone.x - person.overflow.left).toBeGreaterThanOrEqual(
      safe.zone.x + safe.zone.w - 1e-9,
    );
  });

  it("background is a static asset (DI-Q6) and decor layout is seeded", () => {
    expect(spec.background.source).toBe("static");
    expect(spec.decor?.seeded).toBe(true);
  });
});

// ------------------------------------------------------------------
// Schema validation (accepts future push/popup, rejects malformed geometry)
// ------------------------------------------------------------------
describe("layoutSpecSchema", () => {
  it("accepts a push spec (1024×512) without safe/decor sections", () => {
    const push = {
      canvas: { w: 1024, h: 512, scales: [1] },
      background: { source: "static" },
      baseline: 0.95,
      subjects: {
        item: {
          zone: { x: 0, y: 0, w: 0.5, h: 1 },
          anchor: "bottom-left",
          fitHeight: { min: 0.4, target: 0.5, max: 0.6 },
          overflow: { left: 0, right: 0, top: 0, bottom: 0 },
        },
        person: {
          zone: { x: 0.25, y: 0, w: 0.5, h: 1 },
          anchor: "bottom-center",
          fitHeight: { min: 0.8, target: 0.9, max: 1 },
          overflow: { left: 0, right: 0, top: 0, bottom: 0.05 },
        },
      },
    };
    expect(layoutSpecSchema.safeParse(push).success).toBe(true);
  });

  it("accepts a popup spec canvas (800×600)", () => {
    const popup = { ...EMAIL_HERO_V1, canvas: { w: 800, h: 600, scales: [1] } };
    expect(layoutSpecSchema.safeParse(popup).success).toBe(true);
  });

  it("rejects a rect that leaves the canvas", () => {
    const bad = structuredClone(EMAIL_HERO_V1);
    bad.subjects.person.zone = { x: 0.8, y: 0, w: 0.3, h: 1 }; // x+w=1.1
    expect(layoutSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects fitHeight with min > target", () => {
    const bad = structuredClone(EMAIL_HERO_V1);
    bad.subjects.item.fitHeight = { min: 0.7, target: 0.6, max: 0.8 };
    expect(layoutSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an empty scales list and a generated background", () => {
    expect(
      layoutSpecSchema.safeParse({
        ...EMAIL_HERO_V1,
        canvas: { w: 1200, h: 600, scales: [] },
      }).success,
    ).toBe(false);
    expect(
      layoutSpecSchema.safeParse({ ...EMAIL_HERO_V1, background: { source: "generated" } })
        .success,
    ).toBe(false);
  });
});

// ------------------------------------------------------------------
// Versioned DB helpers
// ------------------------------------------------------------------
describe("layout spec versioning", () => {
  it("createLayoutSpecVersion appends version = last + 1", async () => {
    db.layoutSpec.findFirst.mockResolvedValue({ version: 3 });
    db.layoutSpec.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: "ls1", isActive: true, ...data }),
    );
    const row = await createLayoutSpecVersion(EMAIL_HERO_KEY, EMAIL_HERO_V1, "admin@x");
    expect(db.layoutSpec.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ key: EMAIL_HERO_KEY, version: 4, createdBy: "admin@x" }),
    });
    expect(row.version).toBe(4);
  });

  it("createLayoutSpecVersion starts at 1 for a new key", async () => {
    db.layoutSpec.findFirst.mockResolvedValue(null);
    db.layoutSpec.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: "ls1", isActive: true, ...data }),
    );
    const row = await createLayoutSpecVersion("push.hero", EMAIL_HERO_V1);
    expect(row.version).toBe(1);
  });

  it("getActiveLayoutSpec resolves the newest active version and validates it", async () => {
    db.layoutSpec.findFirst.mockResolvedValue({
      id: "ls2",
      key: EMAIL_HERO_KEY,
      version: 2,
      spec: EMAIL_HERO_V1,
      isActive: true,
    });
    const row = await getActiveLayoutSpec(EMAIL_HERO_KEY);
    expect(db.layoutSpec.findFirst).toHaveBeenCalledWith({
      where: { key: EMAIL_HERO_KEY, isActive: true },
      orderBy: { version: "desc" },
    });
    expect(row?.version).toBe(2);
    expect(row?.spec.canvas.w).toBe(1200);
  });

  it("getActiveLayoutSpec throws on a corrupted stored spec (fail loud, not render wrong)", async () => {
    db.layoutSpec.findFirst.mockResolvedValue({
      id: "ls3",
      key: EMAIL_HERO_KEY,
      version: 3,
      spec: { canvas: { w: 1200 } },
      isActive: true,
    });
    await expect(getActiveLayoutSpec(EMAIL_HERO_KEY)).rejects.toThrow();
  });

  it("getLayoutSpecVersion pins an exact version for old bundles", async () => {
    db.layoutSpec.findUnique.mockResolvedValue({
      id: "ls1",
      key: EMAIL_HERO_KEY,
      version: 1,
      spec: EMAIL_HERO_V1,
      isActive: false,
    });
    const row = await getLayoutSpecVersion(EMAIL_HERO_KEY, 1);
    expect(db.layoutSpec.findUnique).toHaveBeenCalledWith({
      where: { key_version: { key: EMAIL_HERO_KEY, version: 1 } },
    });
    expect(row?.isActive).toBe(false);
    expect(row?.spec.baseline).toBeCloseTo(0.92, 5);
  });
});
