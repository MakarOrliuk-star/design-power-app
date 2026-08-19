import sharp from "sharp";

/**
 * Designer ZIP intake (TASK game-manager, Phase 2).
 *
 * Q11: the customer has not handed over a real archive yet, so the classifier
 * is deliberately layered — folder names first (what a designer actually
 * organises by), file-name keywords second, and the alpha channel as the last
 * resort. Whatever convention the real archive turns out to use, at most one of
 * these rules changes; the rest of the pipeline does not.
 */

export type GameLayer = "BACKGROUND" | "PERSON";

/** Q12: three formats. */
const ALLOWED_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);

/** Q12: the customer's ceiling for one upload. */
export const MAX_ZIP_BYTES = 200 * 1024 * 1024;
/** A sane guard so one archive can't fill Cloudinary by accident. */
export const MAX_ENTRIES = 500;

const BACKGROUND_WORDS = ["background", "backgrounds", "bg", "фон", "фоны", "back"];
const PERSON_WORDS = [
  "person",
  "persons",
  "people",
  "character",
  "characters",
  "hero",
  "mascot",
  "item",
  "персонаж",
  "персонажи",
  "человек",
];

export function extensionOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? "" : path.slice(i).toLowerCase();
}

/**
 * Entries worth reading: real image files only.
 *
 * Also the zip-slip guard — an entry named `../../etc/passwd` never reaches
 * disk here (we stream into buffers), but it must not reach Cloudinary as a
 * public_id either, and rejecting it outright is cheaper than sanitising.
 */
export function isUsableEntry(path: string): boolean {
  if (path.endsWith("/")) return false; // directory
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return false; // absolute
  if (path.split(/[\\/]/).some((seg) => seg === "..")) return false; // traversal
  const base = path.split(/[\\/]/).pop() ?? "";
  if (!base || base.startsWith(".")) return false; // dotfile / AppleDouble
  if (path.split(/[\\/]/).includes("__MACOSX")) return false;
  return ALLOWED_EXT.has(extensionOf(base));
}

/**
 * Layer from the path alone. Folder segments win over the file name, because a
 * designer who bothers to sort into `background/` means it; a file merely
 * *named* "casino_background_final" may well be a person on a background.
 * Returns null when the path says nothing — the caller then looks at pixels.
 */
export function classifyByPath(path: string): GameLayer | null {
  const segments = path.split(/[\\/]/).map((s) => s.toLowerCase());
  const folders = segments.slice(0, -1);
  const file = segments[segments.length - 1] ?? "";

  const match = (haystack: string[], words: string[]) =>
    haystack.some((seg) => words.some((w) => seg === w || seg.includes(w)));

  if (match(folders, BACKGROUND_WORDS)) return "BACKGROUND";
  if (match(folders, PERSON_WORDS)) return "PERSON";
  if (match([file], BACKGROUND_WORDS)) return "BACKGROUND";
  if (match([file], PERSON_WORDS)) return "PERSON";
  return null;
}

/** A cut-out has meaningful transparency; a background fills its frame. */
export const TRANSPARENCY_THRESHOLD = 0.02;

/**
 * Layer from the pixels: a file with a real transparent margin is a cut-out
 * character, anything opaque is a background. `hasAlpha` alone is not enough —
 * plenty of exported PNGs carry a fully opaque alpha channel.
 */
export async function classifyByPixels(buffer: Buffer): Promise<GameLayer> {
  try {
    const image = sharp(buffer);
    const meta = await image.metadata();
    if (!meta.hasAlpha) return "BACKGROUND";
    const stats = await image.stats();
    const alpha = stats.channels[3];
    if (!alpha) return "BACKGROUND";
    // A fully opaque alpha channel has min = max = 255.
    if (alpha.min >= 255) return "BACKGROUND";
    // mean is 0..255; how far below fully-opaque the image sits overall.
    const transparentShare = 1 - alpha.mean / 255;
    return transparentShare >= TRANSPARENCY_THRESHOLD ? "PERSON" : "BACKGROUND";
  } catch {
    return "BACKGROUND";
  }
}

export async function classifyEntry(path: string, buffer: Buffer): Promise<GameLayer> {
  return classifyByPath(path) ?? (await classifyByPixels(buffer));
}

/** Cloudinary public_id / display name: no separators, no extension. */
export function assetNameOf(path: string): string {
  const base = (path.split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, "");
  const cleaned = base
    .replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 80);
  // A name made only of punctuation collapses to separators, which is no more
  // useful than an empty one — fall back rather than store "_".
  return cleaned || "asset";
}
