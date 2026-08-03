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
  EMAIL_HERO_V2,
  EMAIL_HERO_V3,
  EMAIL_HERO_KEY,
  PUSH_HERO_V1,
  POPUP_HERO_V1,
  SPEC_KEY_BY_ASSET,
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
// Transparent delivery (требование заказчика: альфа-канал вместо вшитого фона)
// ------------------------------------------------------------------
describe("transparent specs — email v2, push, pop-up", () => {
  it("all three ship an alpha canvas of the canonical size", () => {
    expect(EMAIL_HERO_V2.background.source).toBe("transparent");
    expect(PUSH_HERO_V1.background.source).toBe("transparent");
    expect(POPUP_HERO_V1.background.source).toBe("transparent");
    expect([EMAIL_HERO_V2.canvas.w, EMAIL_HERO_V2.canvas.h]).toEqual([1200, 600]);
    expect([PUSH_HERO_V1.canvas.w, PUSH_HERO_V1.canvas.h]).toEqual([1024, 512]);
    expect([POPUP_HERO_V1.canvas.w, POPUP_HERO_V1.canvas.h]).toEqual([800, 600]);
    for (const s of [EMAIL_HERO_V2, PUSH_HERO_V1, POPUP_HERO_V1]) {
      expect(layoutSpecSchema.safeParse(s).success).toBe(true);
      // Single scale → single stored file (D-E7 + отказ от retina-копий).
      expect(s.canvas.scales).toEqual([1]);
    }
  });

  it("email v2 keeps v1 geometry but widens the item bleed to the Фаза 0 default", () => {
    expect(EMAIL_HERO_V2.subjects.person).toEqual(EMAIL_HERO_V1.subjects.person);
    expect(EMAIL_HERO_V2.safe).toEqual(EMAIL_HERO_V1.safe);
    expect(EMAIL_HERO_V2.baseline).toBe(EMAIL_HERO_V1.baseline);
    expect(EMAIL_HERO_V2.subjects.item.overflow.left).toBe(0.06);
  });

  it("push/pop-up match the эталоны: centered character, props scattered, no text zone", () => {
    // Measured on figma/crm-bundle/*эталон.png (pixel scan 2026-07-27):
    // push — character y 0.025..0.949, popup — y 0.072..0.948, both centered.
    const MEASURED = {
      push: { height: 0.924, baseline: 0.949, propHeights: [0.117, 0.377] },
      popup: { height: 0.877, baseline: 0.948, propHeights: [0.1, 0.347] },
    };
    for (const [name, s] of [
      ["push", PUSH_HERO_V1],
      ["popup", POPUP_HERO_V1],
    ] as const) {
      const m = MEASURED[name];
      expect(s.safe).toBeUndefined(); // no protected text area on push/pop-up
      // No standing item cluster — every object is a scattered prop.
      expect(s.subjects.item).toBeUndefined();
      expect(s.subjects.person.anchor).toBe("bottom-center");
      const center = s.subjects.person.zone.x + s.subjects.person.zone.w / 2;
      expect(Math.abs(center - 0.5)).toBeLessThan(0.01);
      expect(Math.abs(s.subjects.person.fitHeight.target - m.height)).toBeLessThan(TOL);
      expect(Math.abs(s.baseline - m.baseline)).toBeLessThan(TOL);
      // Props come from the ITEM layer, tilted, sized like the measured ones.
      expect(s.decor?.source).toBe("static+item");
      expect(s.decor!.rotationMaxDeg).toBeGreaterThan(0);
      expect(s.decor!.minItemSize!).toBeLessThanOrEqual(m.propHeights[0] + TOL);
      expect(s.decor!.maxItemSize).toBeGreaterThanOrEqual(m.propHeights[1] - TOL);
      // Bands sit in the side margins, clear of the centered character.
      for (const band of s.decor!.bands) {
        const clearLeft = band.x + band.w <= s.subjects.person.zone.x + 0.03;
        const clearRight = band.x >= s.subjects.person.zone.x + s.subjects.person.zone.w - 0.03;
        expect(clearLeft || clearRight).toBe(true);
      }
    }
  });

  it("email v2 scatters the leftover item pieces as decor", () => {
    expect(EMAIL_HERO_V2.decor?.source).toBe("static+item");
    expect(EMAIL_HERO_V2.decor?.maxPieces).toBeGreaterThan(0);
    // The item subject survives — the hero piece still stands on the left.
    expect(EMAIL_HERO_V2.subjects.item).toBeDefined();
  });

  it("maps asset keys to their spec keys for configs that pin none", () => {
    expect(SPEC_KEY_BY_ASSET).toEqual({
      email: "email.hero",
      push: "push.hero",
      popup: "popup.hero",
    });
  });
});

// ------------------------------------------------------------------
// email.hero v3 — визуальный паттерн эталонов (Задание 2, Фаза 1).
// Числа ниже сняты скриптами Фазы 0 с эталонов дизайнеров:
//   scripts/mine-pattern.ts            — коридоры субъектов и полос;
//   scripts/calibrate-scatter.ts       — кольцо и размеры слоёв (134 объекта);
//   радиальный профиль альфы `эталон email.png` — плашка.
// Это DoD Фазы 1: «значения совпадают с замерами эталонов в пределах допуска».
// ------------------------------------------------------------------
const PATTERN = {
  // ex1..ex5, % высоты холста
  personHeight: { min: 77.7, max: 92.0 },
  itemHeight: { min: 84.4, max: 91.0 },
  // покрытие полосы 25–72% и ядра 40–60%, %
  decorCoverage: { min: 6.1, max: 10.2 },
  coreBright: { min: 0.7, max: 2.4 },
  // радиус в нормированном квадрате: ни одного объекта ближе к центру
  ringEmptyBelow: 0.42,
  ringP05: 0.57,
  ringP95: 1.15,
  // высоты объектов по слоям, % высоты холста
  layerSize: { back: [22.3, 43.2], mid: [10.2, 20.9], front: [1.8, 10.0] },
  // `эталон email.png`: alpha 47/255 в центре, углы 0
  glowAlphaCenter: 47 / 255,
} as const;

describe("email.hero.v3 pattern calibration vs reference measurements", () => {
  it("subject heights sit inside the measured corridors", () => {
    const item = EMAIL_HERO_V3.subjects.item!;
    expect(item.fitHeight.min * 100).toBeGreaterThanOrEqual(PATTERN.itemHeight.min - 1);
    expect(item.fitHeight.max * 100).toBeLessThanOrEqual(PATTERN.itemHeight.max + 1);
    const person = EMAIL_HERO_V3.subjects.person;
    expect(person.fitHeight.min * 100).toBeGreaterThanOrEqual(PATTERN.personHeight.min - 1);
    expect(person.fitHeight.max * 100).toBeLessThanOrEqual(PATTERN.personHeight.max + 1);
  });

  it("fixes the two P0 geometry defects of v2: item scale and the ground line", () => {
    // v2 давало item в 62% высоты при эталонных 84–91% и оставляло 8% воздуха
    // под фигурами — отсюда «висящие наклейки» на result.png.
    expect(EMAIL_HERO_V2.subjects.item!.fitHeight.target).toBeLessThan(0.7);
    expect(EMAIL_HERO_V3.subjects.item!.fitHeight.target).toBeGreaterThanOrEqual(0.84);
    expect(EMAIL_HERO_V2.baseline).toBeLessThan(1);
    expect(EMAIL_HERO_V3.baseline).toBe(1);
  });

  it("scatter ring keeps the core empty by geometry, not by prohibition", () => {
    const ring = EMAIL_HERO_V3.scatter!.ring;
    // Ни один объект эталонов не лежит ближе 0.42 — кольцо начинается дальше.
    expect(ring.rMin).toBeGreaterThan(PATTERN.ringEmptyBelow);
    expect(ring.rMin).toBeCloseTo(PATTERN.ringP05, 2);
    expect(ring.rMax).toBeCloseTo(PATTERN.ringP95, 2);
    // rMax > 1.0 → часть объектов свисает за кромку: приём П4 из геометрии.
    expect(ring.rMax).toBeGreaterThan(1);
  });

  it("scatter layer sizes match the measured depth planes", () => {
    const byId = Object.fromEntries(EMAIL_HERO_V3.scatter!.layers.map((l) => [l.id, l]));
    for (const [id, [lo, hi]] of Object.entries(PATTERN.layerSize)) {
      const layer = byId[id]!;
      expect(layer.sizePct[0] * 100).toBeGreaterThanOrEqual(lo - 3);
      expect(layer.sizePct[1] * 100).toBeLessThanOrEqual(hi + 3);
    }
    // П2: back — единственный слой с реальным блюром и обязательным кропом.
    expect(byId.back!.mustCropEdge).toBe(true);
    expect(byId.back!.edges).toEqual(["top"]);
    expect(byId.back!.blurPx[0]).toBeGreaterThan(0);
    expect(byId.front!.blurPx[1]).toBeLessThanOrEqual(1);
  });

  it("angle weights favour the upper half, as the references do", () => {
    const w = EMAIL_HERO_V3.scatter!.angleWeights;
    expect(w).toHaveLength(8);
    // Сектора 4..7 (лево, верх-лево, верх, верх-право) против 0..3.
    const upper = w[4]! + w[5]! + w[6]! + w[7]!;
    const lower = w[0]! + w[1]! + w[2]! + w[3]!;
    expect(upper).toBeGreaterThan(lower);
  });

  it("acceptance corridors V4/V5/V6 come from the measurements", () => {
    const s = EMAIL_HERO_V3.scatter!;
    expect(s.band).toEqual({ x: 0.25, w: 0.47 }); // полоса 25–72% из TASK §2.2
    expect(s.targetCoveragePct[0]).toBeLessThanOrEqual(PATTERN.decorCoverage.min);
    expect(s.targetCoveragePct[1]).toBeGreaterThanOrEqual(PATTERN.decorCoverage.max);
    expect(s.targetObjectCount).toEqual([6, 11]);
    // Ядро: эталоны дают 0.7–2.4% — порог не может быть строже факта.
    expect(EMAIL_HERO_V3.safe!.levels!.core.maxCoverage * 100).toBeGreaterThanOrEqual(
      PATTERN.coreBright.max,
    );
  });

  it("glow plate matches the reference profile and keeps the corners clear", () => {
    const plate = EMAIL_HERO_V3.background.glowPlate!;
    expect(EMAIL_HERO_V3.background.source).toBe("transparent"); // D-E5 в силе
    expect(plate.alphaCenter).toBeCloseTo(PATTERN.glowAlphaCenter, 2);
    expect(plate.radius).toBeGreaterThan(1); // спадает к нулю за кромкой
    // П8: цвет берётся из слоёв, а не настраивается на каждый бренд руками.
    expect(plate.colorSource).toBe("auto-from-layers");
    // V2′ — порог приёмки не строже того, что задаёт сама плашка.
    expect(EMAIL_HERO_V3.validation!.glowAlphaCenterMin!).toBeLessThanOrEqual(plate.alphaCenter);
    expect(EMAIL_HERO_V3.validation!.minTransparentSharePct!).toBeGreaterThan(0);
  });

  it("keeps the delivery contract of v2 untouched (D-E5, D-E7, DI-Q7)", () => {
    expect(EMAIL_HERO_V3.canvas).toEqual(EMAIL_HERO_V2.canvas); // один файл 1200×600
    expect(EMAIL_HERO_V3.safe!.zone).toEqual(EMAIL_HERO_V2.safe!.zone); // контракт E-P5.1
  });

  it("text envelopes fit DI-Q7 (27–73%) and never overlap the subject zones (F5-2)", () => {
    // Живой прогон: конверт v1 тянулся до 0.74, зона персонажа начинается на
    // 0.73 — широкий поясной кроп законно упирался в конверт (2128 px в
    // safe-core-clean). Текст письма живёт в 27–73% ширины (DI-Q7) — конверты
    // обязаны сидеть внутри и не пересекать зоны субъектов v3.
    const personZoneL = EMAIL_HERO_V3.subjects.person.zone.x;
    const itemZoneR =
      EMAIL_HERO_V3.subjects.item!.zone.x + EMAIL_HERO_V3.subjects.item!.zone.w;
    for (const core of EMAIL_HERO_V3.safe!.coreRects) {
      expect(core.x).toBeGreaterThanOrEqual(0.27 - 1e-9);
      expect(core.x + core.w).toBeLessThanOrEqual(0.73 + 1e-9);
      expect(core.x + core.w).toBeLessThanOrEqual(personZoneL + 1e-9);
      expect(core.x).toBeGreaterThanOrEqual(itemZoneR + 1e-9);
    }
  });

  it("crops the person to a waist-up plane from the shared full-body layer", () => {
    // DV-C3: лишних генераций нет — режем кодом, push/pop-up не трогаем.
    expect(EMAIL_HERO_V3.subjects.person.cropTopFraction).toBeGreaterThan(0.4);
    expect(EMAIL_HERO_V3.subjects.person.cropTopFraction).toBeLessThan(0.8);
    expect(PUSH_HERO_V1.subjects.person.cropTopFraction).toBeUndefined();
    expect(POPUP_HERO_V1.subjects.person.cropTopFraction).toBeUndefined();
  });

  it("draws the sign itself and places it beside the person (DV-C4′)", () => {
    const slots = Object.fromEntries(EMAIL_HERO_V3.typography3d!.slots.map((s) => [s.id, s]));
    expect(slots.brandMark!.enabled).toBe(true);
    expect(slots.brandMark!.tokens).toContain("FS");
    // Вариант «просить объект у генератора» отпал: слой персонажа общий с
    // push/pop-up, а там у части брендов персонаж — животное без рук (F2-1).
    expect(slots.heldSign!.enabled).toBe(true);
    expect(slots.heldSign!.placement).toBe("beside-person");
    expect(slots.heldSign!.tokens).toContain("BIG WIN");
  });

  it("back layer stays within the ambience opacity limit", () => {
    // TASK §4.4 разрешает ядру только расфокусированную ambience. Если слой
    // `back` выйдет за `maxOpacity`, движок вытеснит его из центра и верх
    // кадра опустеет — именно это и произошло на первой калибровке.
    const back = EMAIL_HERO_V3.scatter!.layers.find((l) => l.id === "back")!;
    const ambience = EMAIL_HERO_V3.safe!.levels!.ambience;
    expect(back.opacity[1]).toBeLessThanOrEqual(ambience.maxOpacity);
    expect(back.blurPx[0]).toBeGreaterThanOrEqual(ambience.minBlurPx);
  });

  it("does not touch the calibrated push/pop-up specs (DV-B2)", () => {
    expect(PUSH_HERO_V1.background.glowPlate).toBeUndefined();
    expect(PUSH_HERO_V1.scatter).toBeUndefined();
    expect(POPUP_HERO_V1.scatter).toBeUndefined();
    expect(PUSH_HERO_V1.subjects.person.zone).toEqual({ x: 0.28, y: 0, w: 0.44, h: 1 });
  });

  it("validates, and so do all older versions after the schema grew", () => {
    for (const spec of [EMAIL_HERO_V1, EMAIL_HERO_V2, EMAIL_HERO_V3, PUSH_HERO_V1, POPUP_HERO_V1]) {
      expect(layoutSpecSchema.safeParse(spec).success).toBe(true);
    }
  });
});

// ------------------------------------------------------------------
// Schema validation (accepts future push/popup, rejects malformed geometry)
// ------------------------------------------------------------------
describe("layoutSpecSchema", () => {
  it("rejects a scatter ring with rMin >= rMax", () => {
    const bad = structuredClone(EMAIL_HERO_V3);
    bad.scatter!.ring = { rMin: 1.2, rMax: 0.5 };
    expect(layoutSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects angleWeights that are not the eight 45° sectors", () => {
    const bad = structuredClone(EMAIL_HERO_V3);
    bad.scatter!.angleWeights = [1, 2, 3, 4];
    expect(layoutSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an inverted range", () => {
    const bad = structuredClone(EMAIL_HERO_V3);
    bad.scatter!.layers[0]!.sizePct = [0.4, 0.1];
    expect(layoutSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a glow plate colour that is not #RRGGBB", () => {
    const bad = structuredClone(EMAIL_HERO_V3);
    bad.background.glowPlate = {
      colorSource: "fixed",
      fixedColor: "gold" as never,
      alphaCenter: 0.2,
      radius: 1,
      falloff: "smooth",
    };
    expect(layoutSpecSchema.safeParse(bad).success).toBe(false);
  });

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
