import { prisma } from "./prisma.js";

/**
 * Shared "pack" engine (TASK welcome-packs, R-Plan round 3).
 *
 * Tournaments and Welcome packs are separate features with separate tables, but
 * the plumbing around them — file-name sanitizing, prompt wrapping, the DES
 * counter and the ZIP path helpers — is identical. These functions used to live
 * in services/tournament.service.ts and routes/tournament.ts; they were MOVED
 * here and re-exported from their old homes, so the tournament tests still
 * import them by their original paths and keep proving nothing changed.
 */

/** How many reference images are mixed into one request (Phase 0). */
export const BRAND_REFS_PER_JOB = 2;

/**
 * File-name part sanitizer (Phase 0 decision): drop parentheses, spaces -> "_",
 * everything else ("&" included) stays. "Spinogambino(Men)" -> "SpinogambinoMen",
 * "Playson & Booongo" -> "Playson_&_Booongo".
 */
export function sanitizeName(s: string): string {
  return s.replace(/[()]/g, "").trim().replace(/\s+/g, "_");
}

/**
 * Wrap the (resolved) element prompt with the page's system template — the
 * existing {{prompt}} mechanism — then append the brand's style prompt.
 */
export function buildPackPrompt(
  systemWrapper: string,
  elementPrompt: string,
  brandStylePrompt: string,
): string {
  const p = elementPrompt.trim();
  const wrapped = !systemWrapper
    ? p
    : systemWrapper.includes("{{prompt}}")
      ? systemWrapper.split("{{prompt}}").join(p)
      : `${systemWrapper}\n${p}`;
  const style = brandStylePrompt.trim();
  return style ? `${wrapped}\n${style}` : wrapped;
}

/**
 * Atomically issue the next DES number (single-row counter, seeded value=100000;
 * the first issued number is 100001 per the spec's own example). UPDATE ...
 * RETURNING makes concurrent downloads collision-free. Deliberately ONE counter
 * for every pack page — Welcome and Tournament exports share the DES sequence.
 */
export async function nextDesNumber(): Promise<number> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const rows = await prisma.$queryRaw<{ value: number }[]>`
      UPDATE "DesCounter" SET value = value + 1 WHERE id = 1 RETURNING value`;
    const value = rows[0]?.value;
    if (value !== undefined) return value;
    // Unseeded DB (config built via the admin panel, seed script never run):
    // create the row once and retry; skipDuplicates keeps a concurrent first
    // download from failing on the unique id.
    await prisma.desCounter.createMany({ data: [{ id: 1, value: 100000 }], skipDuplicates: true });
  }
  throw new Error("des_counter_missing");
}

// ---- ZIP export helpers ----

/** Force a PNG delivery URL (spec: files in the ZIP are .png). */
export function toPngUrl(url: string): string {
  if (/\.png(\?|$)/i.test(url)) return url;
  // Cloudinary: an f_png transformation converts on the fly.
  if (url.includes("/upload/")) return url.replace("/upload/", "/upload/f_png/");
  return url;
}

/** "Bonuskong_Tournament_1_2" -> its pack folder "Bonuskong_Tournament_1". */
export function packFolderOf(fileName: string): string {
  return fileName.replace(/_\d+$/, "");
}

/** Per-brand image index: trailing number of the fixed file name ("…_2" -> "2"). */
export function trailingIndexOf(fileName: string): string {
  const m = /_(\d+)$/.exec(fileName);
  return m ? m[1]! : "1";
}

/**
 * "Spinogambino(Men)" -> { base: "Spinogambino", gender: "men" }. The (Men)/
 * (Women) pair shares ONE brand folder in the ZIP; the gender moves to the
 * file-name suffix instead. Mirrors the UI's stripGender rule.
 */
export function splitBrandGender(name: string): { base: string; gender: "" | "men" | "women" } {
  const m = /\s*\((men|women)\)\s*$/i.exec(name);
  if (!m) return { base: name.trim(), gender: "" };
  return {
    base: name.slice(0, m.index).trim(),
    gender: m[1]!.toLowerCase() as "men" | "women",
  };
}

/** Collision-free archive path: appends "-2", "-3"... before the extension. */
export function uniqueEntryPath(used: Set<string>, path: string): string {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const m = /^(.*)(\.[a-z0-9]+)$/i.exec(path);
  const stem = m ? m[1]! : path;
  const ext = m ? m[2]! : "";
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}
