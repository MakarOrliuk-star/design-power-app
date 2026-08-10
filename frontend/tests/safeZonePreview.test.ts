import { describe, it, expect } from "vitest";
import { safeZoneStyle, safeContrast } from "~/composables/useSafeZonePreview";
import type { BundleAssetMeta } from "~/stores/bundles";

// CRM safe-zone overlay (TASK email-composition, Фаза 5): the designer sees
// where the письмо's text will land BEFORE Smartico assembles it. Geometry is
// percentages, so the overlay holds at any card width and at @2x.
function meta(over: Partial<BundleAssetMeta> = {}): BundleAssetMeta {
  return {
    specKey: "email.hero",
    specVersion: 1,
    safeZonePct: { x: 27, y: 12, w: 46, h: 76 },
    recommendedTextColor: "#111111",
    luminance: 0.82,
    textContrast: { white: 1.21, dark: 14.42 },
    retinaUrl: null,
    validator: { passed: true, attempts: 1 },
    ...over,
  };
}

describe("safeZoneStyle", () => {
  it("maps the zone percentages onto the frame and takes the recommended colour", () => {
    expect(safeZoneStyle(meta())).toEqual({
      left: "27%",
      top: "12%",
      width: "46%",
      height: "76%",
      color: "#111111",
    });
  });

  it("falls back to dark text when the engine recommended nothing", () => {
    expect(safeZoneStyle(meta({ recommendedTextColor: null })).color).toBe("#111111");
  });

  // TASK multiformat-promo (DI2-4): push и pop-up идут без текста, safe-зоны у
  // них нет — оверлей обязан просто исчезнуть, а не рисовать зону из нулей.
  it("прячет оверлей у форматов без safe-зоны", () => {
    expect(safeZoneStyle(meta({ safeZonePct: null }))).toEqual({ display: "none" });
  });
});

describe("safeContrast", () => {
  it("reports the ratio of the colour actually recommended", () => {
    expect(safeContrast(meta())).toBe("14.4:1");
    expect(safeContrast(meta({ recommendedTextColor: "#FFFFFF" }))).toBe("1.2:1");
  });

  it("shows a dash when the asset carries no measurement", () => {
    expect(safeContrast(meta({ textContrast: null }))).toBe("—");
  });
});
