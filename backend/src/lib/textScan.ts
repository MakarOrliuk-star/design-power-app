import { createHash } from "node:crypto";
import { prisma } from "./prisma.js";
import { env } from "../env.js";

/**
 * Marketing-text detection for CRM email images (TASK Трек A, spike 4.C0).
 *
 * Detector: fal.ai `any-llm/vision` with the budget `gemini-flash-1.5-8b` —
 * validated on figma/osr-samples (offer banner flagged; decorative A/Q/J art
 * clean). Results are cached in ImageTextScan by the bytes' MD5, which doubles
 * as the "пометить ок" whitelist key.
 *
 * Everything here is BEST-EFFORT: any failure (no key, timeout, bad JSON)
 * returns null and must never fail the generation job. A per-pack time budget
 * caps the total scanning time so a degraded fal can't stall a job.
 */

export const TEXT_SCAN_ENDPOINT = "https://fal.run/fal-ai/any-llm/vision";
export const TEXT_SCAN_MODEL = "google/gemini-flash-1.5-8b";
export const TEXT_SCAN_TIMEOUT_MS = 10_000; // per fal call
export const TEXT_SCAN_ATTEMPTS = 2;
export const TEXT_SCAN_PACK_BUDGET_MS = 120_000; // per generation job
export const TEXT_SCAN_MAX_TEXT_LEN = 500;

export const TEXT_SCAN_SYSTEM_PROMPT = `You are a strict QA checker for casino CRM email images.
Decide whether the image contains BAKED-IN MARKETING TEXT.

Marketing text = readable promotional words, phrases, amounts or calls to action
rendered as flat typography over the image: e.g. "UP TO 500000$", "+50 FREE SPINS",
"Start Playing", "Deposit now", percentages with offer context.

NOT marketing text (must NOT trigger):
- single decorative glyphs on game objects: card letters A, Q, J, K, numbers on chips;
- brand logos / watermarks;
- short words that are clearly part of a drawn 3D art object or prop (e.g. golden
  "BIG WIN" letters a character holds) — UNLESS the image also has flat promo typography;
- fully text-free art.

Reply with ONLY this JSON, no markdown fences:
{"has_marketing_text": true|false, "found_text": "<the promo text you can read, else empty>", "confidence": <0..1>}`;

const USER_PROMPT = "Check this image and reply with the JSON verdict only.";

export interface TextScanVerdict {
  hasText: boolean;
  text: string;
  confidence: number; // 0..1
}
export interface TextScanResult extends TextScanVerdict {
  md5: string;
  approvedOk: boolean;
}

/** Per-pack scanning budget — created once per job, passed to every scan. */
export interface ScanBudget {
  deadline: number;
}
export function newScanBudget(ms: number = TEXT_SCAN_PACK_BUDGET_MS): ScanBudget {
  return { deadline: Date.now() + ms };
}

/**
 * Extract the model's JSON verdict from its raw text output (which may wrap
 * the JSON in prose or code fences). Null = unusable answer.
 */
export function parseVerdict(output: unknown): TextScanVerdict | null {
  const m = /\{[\s\S]*\}/.exec(String(output ?? ""));
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    if (typeof j.has_marketing_text !== "boolean") return null;
    const conf = typeof j.confidence === "number" ? Math.min(Math.max(j.confidence, 0), 1) : 0;
    const text =
      typeof j.found_text === "string" ? j.found_text.slice(0, TEXT_SCAN_MAX_TEXT_LEN) : "";
    return { hasText: j.has_marketing_text, text, confidence: conf };
  } catch {
    return null;
  }
}

/** Data-URI mime from the image magic bytes (email images are usually webp). */
export function sniffMime(buffer: Buffer): string {
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer.toString("ascii", 1, 4) === "PNG")
    return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  return "image/png";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callFalVision(buffer: Buffer): Promise<TextScanVerdict | null> {
  const dataUri = `data:${sniffMime(buffer)};base64,${buffer.toString("base64")}`;
  const payload = JSON.stringify({
    model: TEXT_SCAN_MODEL,
    system_prompt: TEXT_SCAN_SYSTEM_PROMPT,
    prompt: USER_PROMPT,
    image_url: dataUri,
  });

  for (let attempt = 1; attempt <= TEXT_SCAN_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(TEXT_SCAN_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Key ${env.FAL_KEY ?? ""}`, "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(TEXT_SCAN_TIMEOUT_MS),
      });
      const text = await res.text();
      if (res.status === 200) {
        const j = JSON.parse(text) as { output?: unknown };
        return parseVerdict(j.output);
      }
      if (!(res.status >= 500 || res.status === 429)) {
        console.warn(`⚠️ textScan: fal HTTP ${res.status}: ${text.slice(0, 200)}`);
        return null; // non-retryable
      }
    } catch (e) {
      if (attempt === TEXT_SCAN_ATTEMPTS) console.warn("⚠️ textScan: fal call failed:", e);
    }
    if (attempt < TEXT_SCAN_ATTEMPTS) await sleep(500);
  }
  return null;
}

/**
 * Scan image bytes for baked-in marketing text. Cache-first by MD5 (a cached
 * verdict — including a whitelisted one — never re-calls the model); a fresh
 * scan respects the pack budget and stores its verdict for every future run.
 */
export async function scanImageBuffer(
  buffer: Buffer,
  budget?: ScanBudget,
): Promise<TextScanResult | null> {
  try {
    const md5 = createHash("md5").update(buffer).digest("hex");

    const cached = await prisma.imageTextScan.findUnique({ where: { md5 } });
    if (cached) {
      return {
        md5,
        hasText: cached.hasText,
        text: cached.text,
        confidence: cached.confidence,
        approvedOk: cached.approvedOk,
      };
    }

    if (!env.FAL_KEY) return null;
    if (budget && Date.now() > budget.deadline) return null; // pack budget spent

    const verdict = await callFalVision(buffer);
    if (!verdict) return null; // failures are not cached — next run retries

    await prisma.imageTextScan.upsert({
      where: { md5 },
      create: { md5, hasText: verdict.hasText, text: verdict.text, confidence: verdict.confidence },
      update: { hasText: verdict.hasText, text: verdict.text, confidence: verdict.confidence },
    });
    return { md5, ...verdict, approvedOk: false };
  } catch (e) {
    console.warn("⚠️ textScan: scan failed:", e);
    return null;
  }
}
