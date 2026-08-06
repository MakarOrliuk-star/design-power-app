import sharp from "sharp";
import { uploadBuffer, withRetry } from "./cloudinary.js";

/**
 * Схема-раскладка email-hero для nano-banana-2 (A-6, TASK ai-reference).
 *
 * Проценты в тексте промпта модель не меряет, поэтому позиционирование
 * показывается КАРТИНКОЙ: последним референсом уходит схема с пропорциями
 * email mask дизайнера — серые боковые панели (~27% ширины, туда контент)
 * и белая центральная полоса (copy space под заголовок/CTA). Кадр banana
 * при этом НЕ модифицируется (A-6: пост-обработка A-4/A-5 отменена) —
 * схема только направляет генерацию.
 */

export const LAYOUT_GUIDE_INSTRUCTION =
  "The LAST image is a LAYOUT GUIDE, not a style reference: the two gray side panels show where " +
  "the content belongs (left gray panel = the large prop group, right gray panel = the main " +
  "character), and the white middle is blank copy space that must stay empty. Follow this layout " +
  "exactly. Do NOT draw the gray panels themselves — they only mark the areas.";

const GUIDE_W = 1200;
const GUIDE_H = 600;
/** Боковые секции схемы — как на email mask (~27% ширины). */
const SECTION_FRACTION = 0.27;
const GUIDE_PUBLIC_ID = "layout_email_1200x600_v1";
const GUIDE_FOLDER = "bundle_refs/_guides";

let cachedUrl: string | null = null;

export async function buildLayoutGuidePng(): Promise<Buffer> {
  const sw = Math.round(GUIDE_W * SECTION_FRACTION);
  const side = await sharp({
    create: { width: sw, height: GUIDE_H, channels: 3, background: { r: 209, g: 209, b: 209 } },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: GUIDE_W, height: GUIDE_H, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([
      { input: side, left: 0, top: 0 },
      { input: side, left: GUIDE_W - sw, top: 0 },
    ])
    .png()
    .toBuffer();
}

/**
 * URL схемы в Cloudinary: рендерится и заливается один раз на процесс
 * (детерминированный public id — повторные заливки просто перезаписывают).
 */
export async function getLayoutGuideUrl(): Promise<string> {
  if (cachedUrl) return cachedUrl;
  const png = await buildLayoutGuidePng();
  const up = await withRetry(() => uploadBuffer(png, GUIDE_PUBLIC_ID, GUIDE_FOLDER), "layout-guide");
  if (!up.success || !up.secure_url) {
    throw new Error(`layout guide upload: ${up.error ?? "unknown"}`);
  }
  cachedUrl = up.secure_url;
  return cachedUrl;
}

/** Сброс кэша (для тестов). */
export function resetLayoutGuideCache(): void {
  cachedUrl = null;
}
