<script setup lang="ts">
/**
 * Scale editor (TASK §1) — Konva-based mini image editor with three tools:
 *
 *  • Expand    — image fixed; drag a resize FRAME outward → outpaint the margins.
 *  • Transform — canvas fixed to the stage; drag/zoom the IMAGE → outpaint the gap.
 *  • Inpaint   — brush a mask over the image → Fill (by prompt) or Erase.
 *
 * Each tool drives ONE Konva.Transformer (or the mask layer), so there is no
 * selection juggling. Coordinates are converted to SOURCE-image pixels before
 * leaving the component: Expand emits a `pad`, Transform emits a `placement`, and
 * Inpaint renders the mask at the source resolution and emits its data URL.
 * Konva needs the DOM, so the stage is <ClientOnly> and the plugin is client-only.
 */
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from "vue";
import type Konva from "konva";
import { capPad, type Pad, type Placement, type InpaintPayload } from "~/composables/useResult";

const props = defineProps<{
  image: { id: string; generatedImageUrl: string; brandName?: string } | null;
  busy: boolean;
  error: string;
  msg: string;
}>();
const emit = defineEmits<{
  (e: "scale", payload: { pad?: Pad; placement?: Placement; prompt?: string }): void;
  (e: "inpaint", payload: InpaintPayload): void;
}>();

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}
type Tool = "expand" | "transform" | "inpaint";
const TOOLS: { key: Tool; label: string }[] = [
  { key: "expand", label: "Расширить" },
  { key: "transform", label: "Двигать/зум" },
  { key: "inpaint", label: "Маска" },
];
const ANCHORS = [
  "top-left", "top-center", "top-right",
  "middle-left", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
];

const tool = ref<Tool>("expand");
const inpaintMode = ref<"fill" | "erase">("fill");
const brush = ref(40); // brush diameter in SOURCE pixels
const outpaintPrompt = ref("");
const inpaintPrompt = ref("");

const wrapRef = ref<HTMLElement | null>(null);
const frameRef = ref<{ getNode: () => Konva.Rect } | null>(null);
const frameTrRef = ref<{ getNode: () => Konva.Transformer } | null>(null);
const imgNodeRef = ref<{ getNode: () => Konva.Image } | null>(null);
const imgTrRef = ref<{ getNode: () => Konva.Transformer } | null>(null);

const stage = reactive({ w: 280, h: 240 });
const natural = ref<{ width: number; height: number } | null>(null);
const htmlImg = ref<HTMLImageElement | null>(null);
const checker = ref<HTMLCanvasElement | null>(null);

// Display px per SOURCE px — the image at ~50% of the stage fit, leaving headroom.
const unit = computed(() => {
  const n = natural.value;
  if (!n) return 1;
  return 0.5 * Math.min(stage.w / n.width, stage.h / n.height);
});
// Base (centered, unscaled) image rect in display coords.
const baseImg = computed(() => {
  const n = natural.value;
  if (!n) return { x: 0, y: 0, width: 0, height: 0 };
  const w = n.width * unit.value;
  const h = n.height * unit.value;
  return { x: (stage.w - w) / 2, y: (stage.h - h) / 2, width: w, height: h };
});

// Expand tool: resize frame (image stays at baseImg).
const frame = reactive<Box>({ x: 0, y: 0, width: 0, height: 0, rotation: 0 });
// Transform tool: movable/scalable image box.
const imgT = reactive<Box>({ x: 0, y: 0, width: 0, height: 0, rotation: 0 });
// Inpaint tool: brush strokes in SOURCE coordinates.
const strokes = ref<{ points: number[]; size: number }[]>([]);
let drawing = false;

function resetScene() {
  const b = baseImg.value;
  frame.x = b.x; frame.y = b.y; frame.width = b.width; frame.height = b.height; frame.rotation = 0;
  imgT.x = b.x; imgT.y = b.y; imgT.width = b.width; imgT.height = b.height; imgT.rotation = 0;
  strokes.value = [];
}

// ---- Derived output (SOURCE px) ----
const pad = computed<Pad>(() => {
  const n = natural.value;
  if (!n) return { top: 0, right: 0, bottom: 0, left: 0 };
  const b = baseImg.value;
  const raw: Pad = {
    left: (b.x - frame.x) / unit.value,
    top: (b.y - frame.y) / unit.value,
    right: (frame.x + frame.width - (b.x + b.width)) / unit.value,
    bottom: (frame.y + frame.height - (b.y + b.height)) / unit.value,
  };
  const c = capPad(raw, n);
  return { top: Math.round(c.top), right: Math.round(c.right), bottom: Math.round(c.bottom), left: Math.round(c.left) };
});
const placement = computed<Placement>(() => ({
  canvasW: Math.round(stage.w / unit.value),
  canvasH: Math.round(stage.h / unit.value),
  imgW: Math.round(imgT.width / unit.value),
  imgH: Math.round(imgT.height / unit.value),
  imgX: Math.round(imgT.x / unit.value),
  imgY: Math.round(imgT.y / unit.value),
}));

const hasMask = computed(() => strokes.value.some((s) => s.points.length >= 2));
const canSubmit = computed(() => {
  if (props.busy || !natural.value) return false;
  if (tool.value === "expand") return pad.value.top + pad.value.right + pad.value.bottom + pad.value.left > 0;
  if (tool.value === "transform") {
    const p = placement.value;
    return p.imgW < p.canvasW || p.imgH < p.canvasH; // image doesn't fill the canvas
  }
  return hasMask.value && (inpaintMode.value === "erase" || !!inpaintPrompt.value.trim());
});

// ---- Konva configs ----
const stageConfig = computed(() => ({ width: stage.w, height: stage.h }));
const checkerConfig = computed(() => ({
  x: frame.x, y: frame.y, width: frame.width, height: frame.height,
  fillPatternImage: checker.value, fillPatternRepeat: "repeat", listening: false,
}));
const stageCanvasConfig = computed(() => ({
  x: 0, y: 0, width: stage.w, height: stage.h,
  fillPatternImage: checker.value, fillPatternRepeat: "repeat", listening: false,
}));
const baseImageConfig = computed(() => ({
  image: htmlImg.value, x: baseImg.value.x, y: baseImg.value.y,
  width: baseImg.value.width, height: baseImg.value.height, listening: false,
}));
const frameConfig = computed(() => ({
  x: frame.x, y: frame.y, width: frame.width, height: frame.height,
  stroke: "#8a38f5", strokeWidth: 1.5, fillEnabled: false, draggable: false,
}));
const movableImageConfig = computed(() => ({
  image: htmlImg.value, x: imgT.x, y: imgT.y, width: imgT.width, height: imgT.height, draggable: true,
}));
const transformerConfig = {
  rotateEnabled: false, keepRatio: false, flipEnabled: false,
  enabledAnchors: ANCHORS, anchorSize: 12, anchorStroke: "#8a38f5",
  anchorFill: "#ffffff", anchorCornerRadius: 6, borderStroke: "#8a38f5",
  boundBoxFunc: frameBound,
};
const imgTransformerConfig = {
  rotateEnabled: false, keepRatio: true, flipEnabled: false,
  enabledAnchors: ["top-left", "top-right", "bottom-left", "bottom-right"],
  anchorSize: 12, anchorStroke: "#8a38f5", anchorFill: "#ffffff",
  anchorCornerRadius: 6, borderStroke: "#8a38f5", boundBoxFunc: imgBound,
};
// Live mask overlay (display coords, derived from source-space strokes).
const maskLines = computed(() =>
  strokes.value.map((s) => ({
    points: srcPointsToDisplay(s.points),
    stroke: inpaintMode.value === "erase" ? "rgba(245,80,80,0.55)" : "rgba(138,56,245,0.55)",
    strokeWidth: s.size * unit.value,
    lineCap: "round",
    lineJoin: "round",
    listening: false,
  })),
);

// Expand frame stays within stage, contains the image, caps pad ≤100%/side.
function frameBound(oldBox: Box, newBox: Box): Box {
  const b = baseImg.value;
  const eps = 0.5;
  const ok =
    newBox.x <= b.x + eps && newBox.y <= b.y + eps &&
    newBox.x + newBox.width >= b.x + b.width - eps &&
    newBox.y + newBox.height >= b.y + b.height - eps &&
    newBox.x >= b.x - b.width && newBox.y >= b.y - b.height &&
    newBox.x + newBox.width <= b.x + b.width + b.width &&
    newBox.y + newBox.height <= b.y + b.height + b.height &&
    newBox.x >= 0 && newBox.y >= 0 &&
    newBox.x + newBox.width <= stage.w && newBox.y + newBox.height <= stage.h;
  return ok ? newBox : oldBox;
}
// Transform image stays inside the stage and above a minimum size.
function imgBound(oldBox: Box, newBox: Box): Box {
  const min = 24;
  const ok =
    newBox.width >= min && newBox.height >= min &&
    newBox.x >= 0 && newBox.y >= 0 &&
    newBox.x + newBox.width <= stage.w && newBox.y + newBox.height <= stage.h;
  return ok ? newBox : oldBox;
}

function bakeRect(node: Konva.Rect | Konva.Image, target: Box) {
  const w = Math.max(5, node.width() * node.scaleX());
  const h = Math.max(5, node.height() * node.scaleY());
  node.scaleX(1); node.scaleY(1); node.width(w); node.height(h);
  target.x = node.x(); target.y = node.y(); target.width = w; target.height = h;
}
function onFrameTransform() {
  const node = frameRef.value?.getNode();
  if (node) bakeRect(node, frame);
}
function onImgTransform() {
  const node = imgNodeRef.value?.getNode();
  if (node) bakeRect(node, imgT);
}
function onImgDrag() {
  const node = imgNodeRef.value?.getNode();
  if (node) {
    // keep inside stage
    const x = Math.min(Math.max(node.x(), 0), stage.w - imgT.width);
    const y = Math.min(Math.max(node.y(), 0), stage.h - imgT.height);
    node.x(x); node.y(y);
    imgT.x = x; imgT.y = y;
  }
}

// ---- Inpaint brush ----
function stagePointToSrc(px: number, py: number): [number, number] {
  const b = baseImg.value;
  return [(px - b.x) / unit.value, (py - b.y) / unit.value];
}
function srcPointsToDisplay(pts: number[]): number[] {
  const b = baseImg.value;
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    out.push(b.x + pts[i]! * unit.value, b.y + pts[i + 1]! * unit.value);
  }
  return out;
}
function onMaskDown(e: { target: { getStage: () => Konva.Stage | null } }) {
  if (tool.value !== "inpaint" || !natural.value) return;
  const pos = e.target.getStage()?.getPointerPosition();
  if (!pos) return;
  drawing = true;
  strokes.value = [...strokes.value, { points: stagePointToSrc(pos.x, pos.y), size: brush.value }];
}
function onMaskMove(e: { target: { getStage: () => Konva.Stage | null } }) {
  if (!drawing) return;
  const pos = e.target.getStage()?.getPointerPosition();
  if (!pos) return;
  const last = strokes.value[strokes.value.length - 1];
  if (last) last.points.push(...stagePointToSrc(pos.x, pos.y));
}
function onMaskUp() {
  drawing = false;
}
function clearMask() {
  strokes.value = [];
}

// Render the mask at SOURCE resolution: white strokes on black.
function buildMaskDataUrl(): string | null {
  const n = natural.value;
  if (!n) return null;
  const c = document.createElement("canvas");
  c.width = n.width;
  c.height = n.height;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, n.width, n.height);
  ctx.strokeStyle = "#ffffff";
  ctx.fillStyle = "#ffffff";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes.value) {
    const p = s.points;
    if (p.length < 2) continue;
    ctx.lineWidth = s.size;
    if (p.length === 2) {
      ctx.beginPath();
      ctx.arc(p[0]!, p[1]!, s.size / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(p[0]!, p[1]!);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i]!, p[i + 1]!);
    ctx.stroke();
  }
  return c.toDataURL("image/png");
}

function submit() {
  if (!canSubmit.value) return;
  if (tool.value === "expand") {
    emit("scale", { pad: pad.value, ...(outpaintPrompt.value.trim() ? { prompt: outpaintPrompt.value.trim() } : {}) });
  } else if (tool.value === "transform") {
    emit("scale", { placement: placement.value, ...(outpaintPrompt.value.trim() ? { prompt: outpaintPrompt.value.trim() } : {}) });
  } else {
    const maskDataUrl = buildMaskDataUrl();
    if (!maskDataUrl) return;
    emit("inpaint", {
      maskDataUrl,
      mode: inpaintMode.value,
      ...(inpaintMode.value === "fill" && inpaintPrompt.value.trim() ? { prompt: inpaintPrompt.value.trim() } : {}),
    });
  }
}

const actionLabel = computed(() => {
  if (props.busy) return "Обработка…";
  if (tool.value === "inpaint") return inpaintMode.value === "erase" ? "Стереть" : "Дорисовать";
  return "Scale";
});

// ---- Lifecycle ----
function probe() {
  natural.value = null;
  htmlImg.value = null;
  if (!import.meta.client || !props.image) return;
  const im = new Image();
  im.onload = () => {
    natural.value = { width: im.naturalWidth, height: im.naturalHeight };
    htmlImg.value = im;
    resetScene();
  };
  im.src = props.image.generatedImageUrl;
}
watch(() => props.image?.id ?? null, probe, { immediate: true });
watch([() => stage.w, () => stage.h], () => {
  if (natural.value) resetScene();
});
watch(tool, () => {
  if (natural.value) resetScene();
});

// Attach each tool's transformer to its node when mounted.
watch([tool, frameRef, frameTrRef, imgNodeRef, imgTrRef, htmlImg], () => {
  if (tool.value === "expand") {
    const tr = frameTrRef.value?.getNode();
    const fr = frameRef.value?.getNode();
    if (tr && fr) { tr.nodes([fr]); tr.getLayer()?.batchDraw(); }
  } else if (tool.value === "transform") {
    const tr = imgTrRef.value?.getNode();
    const im = imgNodeRef.value?.getNode();
    if (tr && im) { tr.nodes([im]); tr.getLayer()?.batchDraw(); }
  }
});

let ro: ResizeObserver | null = null;
function measure() {
  const el = wrapRef.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (r.width > 0) stage.w = Math.round(r.width);
  if (r.height > 0) stage.h = Math.round(r.height);
}
onMounted(() => {
  const c = document.createElement("canvas");
  c.width = 16; c.height = 16;
  const ctx = c.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#f4f4f6"; ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = "#e0e0e6"; ctx.fillRect(0, 0, 8, 8); ctx.fillRect(8, 8, 8, 8);
  }
  checker.value = c;
  measure();
  if (typeof ResizeObserver !== "undefined" && wrapRef.value) {
    ro = new ResizeObserver(measure);
    ro.observe(wrapRef.value);
  }
});
onBeforeUnmount(() => ro?.disconnect());
</script>

<template>
  <section class="scale">
    <h2 class="scale__title">Scale image</h2>

    <p v-if="!image" class="scale__hint">
      Выберите ровно одну картинку, чтобы редактировать её (расширить, двигать/зумить или дорисовать по маске).
    </p>

    <template v-else>
      <div class="scale__tools" role="tablist">
        <button
          v-for="t in TOOLS"
          :key="t.key"
          type="button"
          :class="['scale__tool', { 'scale__tool--on': tool === t.key }]"
          @click="tool = t.key"
        >{{ t.label }}</button>
      </div>

      <div ref="wrapRef" class="scale__stage">
        <p v-if="!natural" class="scale__loading">Загрузка…</p>
        <ClientOnly>
          <v-stage v-if="natural && htmlImg && checker" :config="stageConfig">
            <v-layer>
              <!-- Expand: checker under frame, fixed image, resizable frame -->
              <template v-if="tool === 'expand'">
                <v-rect :config="checkerConfig" />
                <v-image :config="baseImageConfig" />
                <v-rect ref="frameRef" :config="frameConfig" @transform="onFrameTransform" @transformend="onFrameTransform" />
                <v-transformer ref="frameTrRef" :config="transformerConfig" />
              </template>

              <!-- Transform: checker across the whole canvas, movable/zoomable image -->
              <template v-else-if="tool === 'transform'">
                <v-rect :config="stageCanvasConfig" />
                <v-image
                  ref="imgNodeRef"
                  :config="movableImageConfig"
                  @transform="onImgTransform"
                  @transformend="onImgTransform"
                  @dragmove="onImgDrag"
                  @dragend="onImgDrag"
                />
                <v-transformer ref="imgTrRef" :config="imgTransformerConfig" />
              </template>

              <!-- Inpaint: static image + brushed mask overlay -->
              <template v-else>
                <v-image :config="baseImageConfig" />
                <v-rect
                  :config="{ x: 0, y: 0, width: stage.w, height: stage.h }"
                  @pointerdown="onMaskDown"
                  @pointermove="onMaskMove"
                  @pointerup="onMaskUp"
                />
                <v-line v-for="(l, i) in maskLines" :key="i" :config="l" />
              </template>
            </v-layer>
          </v-stage>
        </ClientOnly>
      </div>

      <!-- Tool-specific controls -->
      <div v-if="tool === 'inpaint'" class="scale__inpaint">
        <div class="scale__seg">
          <button type="button" :class="['scale__seg-btn', { 'scale__seg-btn--on': inpaintMode === 'fill' }]" @click="inpaintMode = 'fill'">Дорисовать</button>
          <button type="button" :class="['scale__seg-btn', { 'scale__seg-btn--on': inpaintMode === 'erase' }]" @click="inpaintMode = 'erase'">Стереть</button>
        </div>
        <label class="scale__brush">
          Кисть {{ brush }}px
          <input v-model.number="brush" type="range" min="8" max="200" step="4" />
        </label>
        <button v-if="hasMask" type="button" class="scale__reset" @click="clearMask">Очистить маску</button>
      </div>

      <div v-else class="scale__meta">
        <span class="scale__added">
          {{ tool === 'expand'
            ? `Добавлено: +${pad.top + pad.right + pad.bottom + pad.left}px`
            : 'Двигайте и масштабируйте картинку в холсте' }}
        </span>
        <button type="button" class="scale__reset" @click="resetScene">Сбросить</button>
      </div>

      <textarea
        v-if="tool !== 'inpaint'"
        v-model="outpaintPrompt"
        class="scale__prompt"
        rows="2"
        placeholder="Что дорисовать по краям (необязательно)"
      />
      <textarea
        v-else-if="inpaintMode === 'fill'"
        v-model="inpaintPrompt"
        class="scale__prompt"
        rows="2"
        placeholder="Что нарисовать в выделенной области"
      />

      <p v-if="error" class="scale__feedback scale__feedback--error">{{ error }}</p>
      <p v-else-if="msg" class="scale__feedback scale__feedback--ok">{{ msg }}</p>
    </template>

    <button class="scale__btn" type="button" :disabled="!canSubmit" @click="submit">
      <span class="scale__btn-ic" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
      {{ actionLabel }}
    </button>
  </section>
</template>

<style scoped>
.scale {
  display: flex;
  flex-direction: column;
  gap: 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-window);
  padding: 18px;
}
.scale__title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--color-text);
}
.scale__hint {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--color-grey);
}
.scale__tools {
  display: inline-flex;
  padding: 3px;
  border-radius: var(--radius-pill);
  background: var(--color-segment);
  gap: 2px;
}
.scale__tool {
  flex: 1;
  border: none;
  background: transparent;
  padding: 7px 10px;
  border-radius: var(--radius-pill);
  font-family: inherit;
  font-size: 12px;
  color: var(--color-grey);
}
.scale__tool--on {
  background: var(--color-white);
  color: var(--color-text);
  box-shadow: var(--shadow-card);
}
.scale__stage {
  position: relative;
  width: 100%;
  height: 240px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-sm);
  background: var(--color-white);
  border: 1px solid var(--color-border);
  overflow: hidden;
  touch-action: none;
}
.scale__loading {
  margin: 0;
  font-size: 13px;
  color: var(--color-grey);
}
.scale__inpaint {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.scale__seg {
  display: inline-flex;
  padding: 3px;
  border-radius: var(--radius-pill);
  background: var(--color-segment);
  gap: 2px;
}
.scale__seg-btn {
  flex: 1;
  border: none;
  background: transparent;
  padding: 7px 10px;
  border-radius: var(--radius-pill);
  font-family: inherit;
  font-size: 12px;
  color: var(--color-grey);
}
.scale__seg-btn--on {
  background: var(--color-white);
  color: var(--color-text);
  box-shadow: var(--shadow-card);
}
.scale__brush {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--color-grey);
}
.scale__brush input {
  flex: 1;
  accent-color: var(--color-accent);
}
.scale__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.scale__added {
  font-size: 12px;
  color: var(--color-grey);
}
.scale__reset {
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: 12px;
  color: var(--color-accent);
  padding: 0;
  align-self: flex-start;
}
.scale__reset:hover {
  text-decoration: underline;
}
.scale__prompt {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-white);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--color-text);
  resize: vertical;
  outline: none;
}
.scale__prompt:focus {
  border-color: var(--color-accent);
}
.scale__feedback {
  margin: 0;
  font-size: 13px;
}
.scale__feedback--error {
  color: var(--color-stop-hover);
}
.scale__feedback--ok {
  color: var(--color-accent);
}
.scale__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 13px 20px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--gradient-active);
  color: var(--color-white);
  font-family: inherit;
  font-size: 15px;
  font-weight: 600;
}
.scale__btn:hover:not(:disabled) {
  filter: brightness(1.04);
}
.scale__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.scale__btn-ic {
  display: inline-grid;
  place-items: center;
}
</style>
