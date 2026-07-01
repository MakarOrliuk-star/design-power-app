import { env } from "../env.js";
import { resolveModel, modelEndpoint } from "./falModels.js";

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
 * POST one fal SYNCHRONOUS job (`fal.run/<model>`) and return the resulting image
 * URL. Light retry on 5xx/429/network; non-retryable HTTP errors fail fast.
 */
async function callFalSync(model: string, body: Record<string, unknown>): Promise<FalRunResult> {
  const endpoint = `https://fal.run/${model}`;
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

/**
 * Run ONE fal job synchronously and return the generated image URL.
 * Empty imageUrls → text-to-image (`<base>`); non-empty → image-to-image
 * (`<base>/edit`). The model is chosen from MODEL_REGISTRY via `modelKey`
 * (Brand.imageModel); null/unknown → the default nano-banana-2. Each model's
 * request body (incl. nano's per-call `seed`) is built by its registry entry.
 * Light retry on 5xx/429/network.
 */
export async function runPersonFal(
  prompt: string,
  imageUrls: string[],
  aspectRatio = "1:1",
  modelKey?: string | null,
): Promise<FalRunResult> {
  const model = resolveModel(modelKey);
  const endpoint = modelEndpoint(model, imageUrls.length > 0);
  const body = model.buildBody(prompt, imageUrls, aspectRatio);
  return callFalSync(endpoint, body);
}

/**
 * Upscale an existing image via `fal-ai/seedvr/upscale/image` (SeedVR2). Used
 * right after the Edit stage, before the result is stored in Cloudinary, so edited
 * images are delivered at higher resolution. Returns the upscaled image URL.
 */
export async function runSeedvrUpscale(
  imageUrl: string,
  upscaleFactor = 2,
): Promise<FalRunResult> {
  if (!imageUrl) return { success: false, error: "no image_url" };
  return callFalSync("fal-ai/seedvr/upscale/image", {
    image_url: imageUrl,
    upscale_mode: "factor",
    upscale_factor: upscaleFactor,
    output_format: "png",
  });
}

/**
 * Midjourney-style outpaint via `fal-ai/bria/expand` (Scale window, TASK §1).
 * The original image is placed at `[originX, originY]` inside a larger
 * `[canvasW, canvasH]` canvas; bria generates only the surrounding empty margins.
 * Unlike the pixel-margin outpaint model, bria takes an arbitrary target canvas
 * (no 700px/side cap) and is trained on licensed data. Returns the expanded URL.
 */
export async function runBriaExpand(
  imageUrl: string,
  opts: {
    canvasW: number;
    canvasH: number;
    originX: number;
    originY: number;
    imgW: number;
    imgH: number;
    prompt?: string;
  },
): Promise<FalRunResult> {
  if (!imageUrl) return { success: false, error: "no image_url" };
  const body: Record<string, unknown> = {
    image_url: imageUrl,
    canvas_size: [opts.canvasW, opts.canvasH],
    original_image_size: [opts.imgW, opts.imgH],
    original_image_location: [opts.originX, opts.originY],
  };
  if (opts.prompt) body.prompt = opts.prompt;
  return callFalSync("fal-ai/bria/expand", body);
}

/**
 * Inpaint by prompt in a masked region via `fal-ai/bria/genfill` (Scale window →
 * Inpaint tool). The mask is a binary image (white = area to regenerate) at the
 * SAME dimensions as the source. `prompt` describes what to fill in.
 */
export async function runBriaGenfill(
  imageUrl: string,
  maskUrl: string,
  prompt: string,
): Promise<FalRunResult> {
  if (!imageUrl || !maskUrl) return { success: false, error: "no image_url / mask_url" };
  return callFalSync("fal-ai/bria/genfill", { image_url: imageUrl, mask_url: maskUrl, prompt });
}

/**
 * Remove content in a masked region via `fal-ai/bria/eraser` (Scale window →
 * Erase tool). No prompt — the model cleans the masked area. Mask is binary
 * (white = area to erase) at the same dimensions as the source.
 */
export async function runBriaEraser(imageUrl: string, maskUrl: string): Promise<FalRunResult> {
  if (!imageUrl || !maskUrl) return { success: false, error: "no image_url / mask_url" };
  return callFalSync("fal-ai/bria/eraser", {
    image_url: imageUrl,
    mask_url: maskUrl,
    mask_type: "manual",
  });
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
