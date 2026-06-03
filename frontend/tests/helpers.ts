import { createApp, reactive } from "vue";
import { vi } from "vitest";
import type { GalleryImage, ResultApi, ResultGen } from "~/composables/useResult";

/**
 * Run a composable inside a real (headless) Vue app so lifecycle hooks
 * (onMounted/watch) and reactivity behave exactly as in a component — but with no
 * Nuxt runtime. Returns the composable result plus an `unmount` to clean up timers
 * and listeners (fires onBeforeUnmount).
 */
export function withSetup<T>(composable: () => T): { result: T; unmount: () => void } {
  let result!: T;
  const app = createApp({
    setup() {
      result = composable();
      return () => null;
    },
  });
  app.mount(document.createElement("div"));
  return { result, unmount: () => app.unmount() };
}

let seq = 0;

/** Build a gallery image with sensible defaults; override any field per test. */
export function makeImage(over: Partial<GalleryImage> = {}): GalleryImage {
  seq += 1;
  return {
    id: `img-${seq}`,
    brandName: "Nike",
    contentType: "Person",
    isEdit: false,
    theme: null,
    description: "a model in the studio",
    generatedImageUrl: `https://cdn.example/${seq}.png`,
    createdAt: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    ...over,
  };
}

/** A `useApi`-shaped mock that resolves the given gallery payload for GET reads. */
export function makeApi(
  payload: { images: GalleryImage[]; total: number; hasMore: boolean },
): ReturnType<typeof vi.fn> & ResultApi {
  return vi.fn(async () => payload) as unknown as ReturnType<typeof vi.fn> & ResultApi;
}

/** A minimal generator-store stand-in (reactive so the runningCount watch fires). */
export function makeGen(): ResultGen & { addBatch: ReturnType<typeof vi.fn> } {
  return reactive({ runningCount: 0, addBatch: vi.fn() }) as ResultGen & {
    addBatch: ReturnType<typeof vi.fn>;
  };
}
