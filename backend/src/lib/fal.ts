import { env } from "../env.js";

/**
 * fal.ai SYNCHRONOUS client — matches the Make blueprint, which calls
 * `https://fal.run/fal-ai/nano-banana-2/edit` and waits for the result
 * (`data.images[].url`). No async queue / webhook (that was the GAS-era path).
 */

export interface FalRunResult {
  success: boolean;
  imageUrl?: string;
  error?: string;
}

function authHeaders() {
  return { Authorization: `Key ${env.FAL_KEY ?? ""}`, "Content-Type": "application/json" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run ONE fal job synchronously and return the generated image URL.
 * Empty imageUrls → text-to-image (nano-banana-2); non-empty → image-to-image
 * (nano-banana-2/edit). Light retry on 5xx/429/network.
 */
export async function runPersonFal(
  prompt: string,
  imageUrls: string[],
  aspectRatio = "1:1",
): Promise<FalRunResult> {
  const hasImages = imageUrls.length > 0;
  const model = hasImages ? "fal-ai/nano-banana-2/edit" : "fal-ai/nano-banana-2";
  const endpoint = `https://fal.run/${model}`;

  const body: Record<string, unknown> = {
    prompt,
    num_images: 1,
    aspect_ratio: aspectRatio,
    output_format: "png",
    resolution: "1K",
  };
  if (hasImages) {
    body.image_urls = imageUrls;
    body.safety_tolerance = "5";
    body.limit_generations = true;
  }

  const payload = JSON.stringify(body);
  let lastError = "unknown";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(endpoint, { method: "POST", headers: authHeaders(), body: payload });
      const text = await res.text();
      if (res.status === 200 || res.status === 201) {
        const url = extractFalImageUrl(JSON.parse(text));
        if (url) return { success: true, imageUrl: url };
        return { success: false, error: `no image in fal response: ${text.slice(0, 160)}` };
      }
      lastError = `HTTP ${res.status}: ${text.slice(0, 160)}`;
      if (!(res.status >= 500 || res.status === 429)) return { success: false, error: lastError };
    } catch (e) {
      lastError = String(e);
    }
    if (attempt < 3) await sleep(Math.min(8000, 1000 * 2 ** (attempt - 1)));
  }
  return { success: false, error: lastError };
}

/** Extract the generated image URL from a fal response (handles known shapes). */
export function extractFalImageUrl(body: unknown): string {
  const root = body as Record<string, unknown> | null;
  if (!root) return "";
  const p = (root.payload as Record<string, unknown>) ?? root;
  const images = p.images as unknown[] | undefined;
  if (images?.length) {
    const first = images[0];
    if (first && typeof first === "object" && "url" in first) return String((first as { url: unknown }).url);
    if (typeof first === "string") return first;
  }
  const image = p.image as unknown;
  if (image && typeof image === "object" && "url" in image) return String((image as { url: unknown }).url);
  if (typeof image === "string") return image;
  if (typeof p.url === "string") return p.url;
  return "";
}
