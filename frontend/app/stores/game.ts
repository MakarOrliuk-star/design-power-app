import { defineStore } from "pinia";
import type {
  GameAsset,
  GameComposition,
  GameLayerKind,
  GamePack,
  GameSegment,
  GameState,
  GameTemplate,
  GameTemplateSpec,
} from "~/types/game";

export type { GameAsset, GameComposition, GamePack, GameSegment, GameTemplate };

/**
 * Game manager page state (TASK game-manager, Phase 2).
 *
 * Standalone, like the welcome/tournament stores: the Game module shares no
 * entities with the Design zone, and a GAME_MANAGER never even loads those
 * pages. Everything the screen needs arrives from one GET /api/game/state.
 */

export const SCALE_MIN = 0.5;
export const SCALE_MAX = 1.5;
export const BLUR_MIN = 1;
export const BLUR_MAX = 40;

// ---------------------------------------------------------------------------
// Pure helpers — no Vue, no Nuxt. Unit-tested directly (tests/gameStencil.test.ts).
// ---------------------------------------------------------------------------

/**
 * Preview overlay geometry, as percentages of the preview box. Mirrors
 * backend/src/lib/gameTemplate.ts#guideLines — the vertical guides are tangent
 * to the inner circle, the horizontal ones to the outer circle, and both radii
 * are fractions of the canvas WIDTH.
 */
export function stencilGuides(spec: GameTemplateSpec, canvasW: number, canvasH: number) {
  const { centerX, centerY, innerRadius, outerRadius } = spec.person;
  const dy = (outerRadius * canvasW) / canvasH;
  return {
    vertical: [centerX - innerRadius, centerX, centerX + innerRadius],
    horizontal: [centerY - dy, centerY, centerY + dy],
  };
}

/** Circle overlay in preview-box percentages (width-relative radius, so the
 *  vertical extent has to be re-expressed against the box height). */
export function stencilCircles(spec: GameTemplateSpec, canvasW: number, canvasH: number) {
  const { centerX, centerY, innerRadius, outerRadius } = spec.person;
  const toBox = (r: number) => ({ rx: r, ry: (r * canvasW) / canvasH });
  return {
    outer: { cx: centerX, cy: centerY, ...toBox(outerRadius) },
    inner: { cx: centerX, cy: centerY, ...toBox(innerRadius) },
  };
}

/**
 * Where the person sits in the PREVIEW, as box percentages. Deliberately the
 * same maths as the backend's computePersonBox so the preview cannot lie about
 * what Save will produce — expressed in fractions rather than pixels because
 * the preview box is a fraction of the real canvas.
 */
export function previewPersonBox(
  spec: GameTemplateSpec,
  personW: number,
  personH: number,
  canvasW: number,
  canvasH: number,
  scale: number,
) {
  const { centerX, centerY, innerRadius, outerRadius, fitCircle } = spec.person;
  const zone = (fitCircle === "inner" ? innerRadius : outerRadius) * 2 * canvasW;
  const fit = Math.min(zone / personW, zone / personH) * scale;
  const w = (personW * fit) / canvasW;
  const h = (personH * fit) / canvasH;
  return { left: centerX - w / 2, top: centerY - h / 2, width: w, height: h };
}

const ERROR_MESSAGES: Record<string, string> = {
  no_layers: "Выберите фон или персонажа.",
  asset_not_found: "Ассет не найден — обновите страницу.",
  fetch_failed: "Не удалось скачать слой из хранилища.",
  upload_failed: "Не удалось сохранить результат. Попробуйте ещё раз.",
  not_a_zip: "Принимается только .zip",
  no_file: "Файл не выбран.",
  no_images_in_archive: "В архиве нет картинок (PNG, JPG или WebP).",
  no_images_stored: "Ни одну картинку не удалось сохранить.",
};

export function messageFor(code: string | null | undefined, fallback: string): string {
  if (!code) return fallback;
  return ERROR_MESSAGES[code] ?? fallback;
}

// ---------------------------------------------------------------------------

export const useGameStore = defineStore("game", () => {
  const loaded = ref(false);
  const loading = ref(false);
  const error = ref("");

  const template = ref<GameTemplate | null>(null);
  const pack = ref<GamePack | null>(null);
  const assets = ref<GameAsset[]>([]);
  const results = ref<GameComposition[]>([]);

  // Assets panel
  const segment = ref<GameSegment>("LIVE");
  const stylePrompt = ref("");

  // Composition
  const backgroundId = ref<string | null>(null);
  const personId = ref<string | null>(null);
  const blur = ref(false);
  const blurSigma = ref(12);
  const scale = ref(1);
  const saving = ref(false);

  const uploading = ref(false);
  /** Set by the deliberate 501s from /generate/* (Q18) — shown as a hint. */
  const notice = ref("");

  const byKind = (kind: GameLayerKind) => computed(() => assets.value.filter((a) => a.kind === kind));
  const backgrounds = byKind("BACKGROUND");
  const persons = byKind("PERSON");

  const background = computed(() => assets.value.find((a) => a.id === backgroundId.value) ?? null);
  const person = computed(() => assets.value.find((a) => a.id === personId.value) ?? null);

  const parsing = computed(() => pack.value?.status === "PARSING");
  const canSave = computed(
    () => !saving.value && (backgroundId.value !== null || personId.value !== null),
  );

  function applyState(state: GameState) {
    template.value = state.template;
    pack.value = state.pack;
    assets.value = state.assets;
    results.value = state.results;
    // Drop selections that the new pack no longer contains (Q13: a fresh ZIP
    // replaces the previous set, so stale ids would silently 404 on Save).
    const ids = new Set(state.assets.map((a) => a.id));
    if (backgroundId.value && !ids.has(backgroundId.value)) backgroundId.value = null;
    if (personId.value && !ids.has(personId.value)) personId.value = null;
  }

  async function load() {
    loading.value = true;
    error.value = "";
    try {
      applyState(await useApi()<GameState>("/api/game/state"));
      loaded.value = true;
      if (parsing.value) pollPack();
    } catch {
      error.value = "Не удалось загрузить страницу.";
    } finally {
      loading.value = false;
    }
  }

  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  /** Poll the pack row while the background parse runs (see game.service.ts). */
  function pollPack() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      const id = pack.value?.id;
      if (!id) return;
      try {
        const res = await useApi()<{ pack: GamePack; assets: GameAsset[] }>(`/api/game/packs/${id}`);
        pack.value = res.pack;
        assets.value = res.assets;
        if (res.pack.status === "PARSING") pollPack();
        else if (res.pack.status === "FAILED") {
          error.value = messageFor(res.pack.error, "Не удалось разобрать архив.");
        }
      } catch {
        // A transient failure shouldn't abandon a running parse — try again.
        pollPack();
      }
    }, 1500);
  }

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  async function uploadPack(file: File) {
    uploading.value = true;
    error.value = "";
    notice.value = "";
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await useApi()<{ pack: GamePack }>("/api/game/packs", { method: "POST", body });
      pack.value = res.pack;
      assets.value = [];
      backgroundId.value = null;
      personId.value = null;
      pollPack();
    } catch (err) {
      const code = (err as { data?: { error?: string } }).data?.error;
      error.value = messageFor(code, "Не удалось загрузить архив.");
    } finally {
      uploading.value = false;
    }
  }

  /** Q18: the backend answers 501 with a human message until the pipeline lands. */
  async function generate(what: "background" | "person") {
    notice.value = "";
    error.value = "";
    try {
      await useApi()(`/api/game/generate/${what}`, {
        method: "POST",
        body: { prompt: stylePrompt.value, segment: segment.value },
      });
    } catch (err) {
      const data = (err as { data?: { error?: string; message?: string } }).data;
      if (data?.error === "not_implemented") notice.value = data.message ?? "Скоро.";
      else error.value = "Не удалось запустить генерацию.";
    }
  }

  async function save() {
    if (!canSave.value) return;
    saving.value = true;
    error.value = "";
    notice.value = "";
    try {
      const res = await useApi()<{ composition: GameComposition }>("/api/game/compose", {
        method: "POST",
        body: {
          backgroundAssetId: backgroundId.value,
          personAssetId: personId.value,
          options: { blur: blur.value, blurSigma: blurSigma.value, scale: scale.value },
        },
      });
      results.value = [res.composition, ...results.value];
    } catch (err) {
      const code = (err as { data?: { error?: string } }).data?.error;
      error.value = messageFor(code, "Не удалось собрать изображение.");
    } finally {
      saving.value = false;
    }
  }

  async function clearAll() {
    const previous = results.value;
    results.value = [];
    try {
      await useApi()("/api/game/results", { method: "DELETE" });
    } catch {
      results.value = previous; // put the feed back rather than lie about it
      error.value = "Не удалось очистить список.";
    }
  }

  return {
    loaded,
    loading,
    error,
    notice,
    template,
    pack,
    assets,
    results,
    segment,
    stylePrompt,
    backgroundId,
    personId,
    blur,
    blurSigma,
    scale,
    saving,
    uploading,
    backgrounds,
    persons,
    background,
    person,
    parsing,
    canSave,
    load,
    uploadPack,
    generate,
    save,
    clearAll,
    stopPolling,
  };
});
