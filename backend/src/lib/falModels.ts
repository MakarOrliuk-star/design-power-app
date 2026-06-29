/**
 * fal.ai model registry. Maps a model KEY (stored on Brand.imageModel, managed in
 * the admin UI) to its base endpoint and a request-body builder.
 *
 * Why a registry: each model family accepts a different request shape — e.g.
 * nano-banana-2 supports `seed` / `safety_tolerance` / `limit_generations`, while
 * xai/grok-imagine-image accepts none of those and uses lowercase `resolution`.
 * Keeping the body logic per-model here means brands only pick a KEY; the admin
 * can re-assign a brand between supported models without touching processor code.
 *
 * Endpoint selection mirrors the legacy behaviour: with reference images we hit
 * `<base>/edit` (image-to-image); without, `<base>` (text-to-image).
 */

export interface FalModel {
  /** Base endpoint path on fal.run, e.g. "fal-ai/nano-banana-2". */
  base: string;
  /** Human label for the admin dropdown. */
  label: string;
  /** Build the POST body for a generation. */
  buildBody(prompt: string, imageUrls: string[], aspectRatio: string): Record<string, unknown>;
}

/** Default model when a brand has no override (Brand.imageModel = null). */
export const DEFAULT_MODEL_KEY = "fal-ai/nano-banana-2";

/** Task 2: fresh pseudo-random seed per call so edits aren't 1:1 with the ref. */
function randomSeed(): number {
  return Math.floor(Math.random() * 999999999);
}

export const MODEL_REGISTRY: Record<string, FalModel> = {
  // Default. Adds `seed` to BOTH text-to-image and edit calls (Task 2).
  "fal-ai/nano-banana-2": {
    base: "fal-ai/nano-banana-2",
    label: "Nano Banana 2 (по умолчанию)",
    buildBody(prompt, imageUrls, aspectRatio) {
      const hasImages = imageUrls.length > 0;
      const body: Record<string, unknown> = {
        prompt,
        num_images: 1,
        aspect_ratio: aspectRatio,
        output_format: "png",
        resolution: "1K",
        seed: randomSeed(),
      };
      if (hasImages) {
        body.image_urls = imageUrls;
        body.safety_tolerance = "5";
        body.limit_generations = true;
      }
      return body;
    },
  },

  // Task 1: Grok Imagine Image. No seed / safety_tolerance / limit_generations;
  // lowercase resolution; image_urls capped at 3 (model limit, nano allowed 14).
  // Per request: Grok ignores the user's 9:16/1:1 pick and always uses
  // aspect_ratio "auto", and outputs jpeg (nano stays png / honours the pick).
  "xai/grok-imagine-image": {
    base: "xai/grok-imagine-image",
    label: "Grok Imagine Image",
    buildBody(prompt, imageUrls, _aspectRatio) {
      const body: Record<string, unknown> = {
        prompt,
        num_images: 1,
        aspect_ratio: "auto",
        output_format: "jpeg",
        resolution: "1k",
      };
      if (imageUrls.length > 0) body.image_urls = imageUrls.slice(0, 3);
      return body;
    },
  },
};

/** Resolve a brand's model key (null/unknown → default) to its registry entry. */
export function resolveModel(modelKey: string | null | undefined): FalModel {
  if (modelKey && MODEL_REGISTRY[modelKey]) return MODEL_REGISTRY[modelKey];
  return MODEL_REGISTRY[DEFAULT_MODEL_KEY]!;
}

/** Endpoint for a model given whether reference images are present. */
export function modelEndpoint(model: FalModel, hasImages: boolean): string {
  return hasImages ? `${model.base}/edit` : model.base;
}

/** All valid model keys (admin PATCH validation accepts any of these). */
export const MODEL_KEYS = Object.keys(MODEL_REGISTRY);

/**
 * Override options for the admin dropdown. The default model is excluded — in the
 * UI it's represented by the "(по умолчанию)" / null choice (Brand.imageModel =
 * null), so listing it again would be a confusing duplicate.
 */
export const MODEL_OPTIONS = MODEL_KEYS.filter((key) => key !== DEFAULT_MODEL_KEY).map((key) => ({
  key,
  label: MODEL_REGISTRY[key]!.label,
}));
