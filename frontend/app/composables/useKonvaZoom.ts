import { ref, computed, watch, onBeforeUnmount, type Ref } from "vue";

/**
 * Viewport zoom/pan for the ScalePanel Konva stage (TASK Трек B).
 *
 * The stage gets a VIEW transform ({scale, x, y} → scaleX/scaleY/x/y) while all
 * scene geometry (frame, image box, brush strokes, pad/placement math) stays in
 * untransformed "content" coordinates — so zooming can't change what is emitted
 * to the backend. Ctrl+wheel (Cmd on macOS) zooms to the cursor; a plain wheel
 * keeps its old behavior (nothing). Panning is started by the host via
 * `startPan` (middle-drag anywhere / left-drag on empty stage) and tracked on
 * `window`, so releasing the button outside the canvas can't leave it stuck.
 */

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 10;
export const ZOOM_STEP = 1.15;
/** Screen px of content that must stay reachable when panning/zooming. */
export const PAN_VISIBLE_MARGIN = 60;

export interface ViewTransform {
  scale: number;
  x: number;
  y: number;
}
export interface ViewportSize {
  w: number;
  h: number;
}

const IDENTITY: ViewTransform = { scale: 1, x: 0, y: 0 };

/**
 * Keep at least PAN_VISIBLE_MARGIN px of the content rect on screen so the
 * user can't pan/zoom the image fully out of view and "lose" it.
 */
export function clampView(view: ViewTransform, viewport: ViewportSize): ViewTransform {
  const m = PAN_VISIBLE_MARGIN;
  const w = viewport.w * view.scale;
  const h = viewport.h * view.scale;
  const x = Math.min(Math.max(view.x, m - w), viewport.w - m);
  const y = Math.min(Math.max(view.y, m - h), viewport.h - m);
  return x === view.x && y === view.y ? view : { scale: view.scale, x, y };
}

/**
 * One wheel tick: scale by ZOOM_STEP towards `dir` keeping the content point
 * under `pointer` (stage-screen coords) stationary. Pure — unit-tested.
 */
export function zoomAt(
  view: ViewTransform,
  pointer: { x: number; y: number },
  dir: 1 | -1,
  viewport: ViewportSize,
): ViewTransform {
  const raw = dir > 0 ? view.scale * ZOOM_STEP : view.scale / ZOOM_STEP;
  const scale = Math.min(Math.max(raw, ZOOM_MIN), ZOOM_MAX);
  if (scale === view.scale) return view;
  const cx = (pointer.x - view.x) / view.scale;
  const cy = (pointer.y - view.y) / view.scale;
  return clampView({ scale, x: pointer.x - cx * scale, y: pointer.y - cy * scale }, viewport);
}

export function useKonvaZoom(
  wrapEl: Ref<HTMLElement | null>,
  active: Ref<boolean>,
  viewport: ViewportSize, // reactive object (the host's `stage` state)
) {
  const view = ref<ViewTransform>({ ...IDENTITY });

  /** Spread into the v-stage config. */
  const stageTransform = computed(() => ({
    scaleX: view.value.scale,
    scaleY: view.value.scale,
    x: view.value.x,
    y: view.value.y,
  }));

  function reset() {
    view.value = { ...IDENTITY };
  }

  function onWheel(e: WheelEvent) {
    // Plain wheel keeps its previous behavior; only the modifier combo zooms —
    // and only then may the browser's page zoom be suppressed.
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const el = wrapEl.value;
    if (!el) return;
    // The stage is measured to fill the wrapper, so wrapper-relative client
    // coords ARE stage-screen coords.
    const r = el.getBoundingClientRect();
    const pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    view.value = zoomAt(view.value, pointer, e.deltaY < 0 ? 1 : -1, viewport);
  }

  // ---- pan (host decides which mousedown is a pan gesture) ----
  let panLast: { x: number; y: number } | null = null;
  function onPanMove(e: MouseEvent) {
    if (!panLast) return;
    const v = view.value;
    view.value = clampView(
      { scale: v.scale, x: v.x + e.clientX - panLast.x, y: v.y + e.clientY - panLast.y },
      viewport,
    );
    panLast = { x: e.clientX, y: e.clientY };
  }
  function endPan() {
    panLast = null;
    window.removeEventListener("mousemove", onPanMove);
    window.removeEventListener("mouseup", endPan);
  }
  function startPan(client: { x: number; y: number }) {
    panLast = { ...client };
    window.addEventListener("mousemove", onPanMove);
    window.addEventListener("mouseup", endPan);
  }

  // ---- listener lifecycle: attached only while the editor is open ----
  let attachedTo: HTMLElement | null = null;
  function detach() {
    attachedTo?.removeEventListener("wheel", onWheel);
    attachedTo = null;
    endPan();
  }
  watch(
    [active, wrapEl],
    ([on, el]) => {
      detach();
      if (on && el) {
        // passive:false — preventDefault must be honored for Ctrl+wheel.
        el.addEventListener("wheel", onWheel, { passive: false });
        attachedTo = el;
      }
      if (!on) reset();
    },
    { immediate: true },
  );
  onBeforeUnmount(detach);

  return { view, stageTransform, reset, startPan };
}
