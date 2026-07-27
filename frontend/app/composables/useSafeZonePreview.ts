import type { BundleAssetMeta } from "~/stores/bundles";

// Safe-zone preview helpers (TASK email-composition, Фаза 5). The engine ships
// the zone in PERCENT of the image (TASK §2.3), so the overlay maps straight
// onto the картинку at any card width and stays valid at @2x.

/** Absolute-position style of the safe zone inside the asset frame. */
export function safeZoneStyle(meta: BundleAssetMeta): Record<string, string> {
  const z = meta.safeZonePct;
  return {
    left: `${z.x}%`,
    top: `${z.y}%`,
    width: `${z.w}%`,
    height: `${z.h}%`,
    color: meta.recommendedTextColor ?? "#111111",
  };
}

/** Contrast of the zone against the recommended text colour — the number the
 *  валидатор gates on (WCAG AA ≥ 4.5:1). */
export function safeContrast(meta: BundleAssetMeta): string {
  if (!meta.textContrast) return "—";
  const isDarkText = (meta.recommendedTextColor ?? "#111111").toLowerCase() !== "#ffffff";
  const ratio = isDarkText ? meta.textContrast.dark : meta.textContrast.white;
  return `${ratio.toFixed(1)}:1`;
}
