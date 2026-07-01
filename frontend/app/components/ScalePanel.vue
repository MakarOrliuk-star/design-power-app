<script setup lang="ts">
/**
 * Scale editor (TASK §1) — Konva-based mini image editor with three tools:
 *
 *  • Expand    — image fixed; drag a resize FRAME outward → outpaint the margins.
 *  • Transform — canvas fixed to the stage; drag/zoom the IMAGE → outpaint the gap.
 *  • Inpaint   — brush a mask over the image → Fill (by prompt) or Erase.
 *
 * The right panel shows a compact preview + "Редактировать" button; the actual
 * editing happens in a large modal so there's room to work and clear labels.
 * Coordinates are converted to SOURCE-image pixels before leaving the component:
 * Expand emits a `pad`, Transform a `placement`, Inpaint a source-res mask URL.
 * Konva needs the DOM, so the stage is <ClientOnly> and the plugin is client-only.
 */
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
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
const TOOLS: { key: Tool; label: string; hint: string }[] = [
  { key: "expand", label: "Расширить", hint: "Тяните за фиолетовые точки на краях рамки наружу — пустые области по краям дорисует ИИ." },
  { key: "transform", label: "Двигать / зум", hint: "Перетаскивайте картинку и тяните за углы, чтобы уменьшить её. Свободное место в холсте дорисует ИИ." },
  { key: "inpaint", label: "Маска", hint: "Закрасьте кистью область. «Дорисовать» заменит её по промпту, «Стереть» — удалит объект." },
];
const ANCHORS = [
  "top-left", "top-center", "top-right",
  "middle-left", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
];

const open = ref(false);
const tool = ref<Tool>("expand");
const inpaintMode = ref<"fill" | "erase">("fill");
const brush = ref(40); // brush diameter in SOURCE pixels
const outpaintPrompt = ref("");
const inpaintPrompt = ref("");

const stageWrapRef = ref<HTMLElement | null>(null);
const frameRef = ref<{ getNode: () => Konva.Rect } | null>(null);
const frameTrRef = ref<{ getNode: () => Konva.Transformer } | null>(null);
const imgNodeRef = ref<{ getNode: () => Konva.Image } | null>(null);
const imgTrRef = ref<{ getNode: () => Konva.Transformer } | null>(null);

const stage = reactive({ w: 600, h: 460 });
const natural = ref<{ width: number; height: number } | null>(null);
const htmlImg = ref<HTMLImageElement | null>(null);
const checker = ref<HTMLCanvasElement | null>(null);

// Display px per SOURCE px — image at ~55% of the stage fit, leaving room to edit.
const unit = computed(() => {
  const n = natural.value;
  if (!n) return 1;
  return 0.55 * Math.min(stage.w / n.width, stage.h / n.height);
});
const baseImg = computed(() => {
  const n = natural.value;
  if (!n) return { x: 0, y: 0, width: 0, height: 0 };
  const w = n.width * unit.value;
  const h = n.height * unit.value;
  return { x: (stage.w - w) / 2, y: (stage.h - h) / 2, width: w, height: h };
});

const frame = reactive<Box>({ x: 0, y: 0, width: 0, height: 0, rotation: 0 });
const imgT = reactive<Box>({ x: 0, y: 0, width: 0, height: 0, rotation: 0 });
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
    return p.imgW < p.canvasW || p.imgH < p.canvasH;
  }
  return hasMask.value && (inpaintMode.value === "erase" || !!inpaintPrompt.value.trim());
});
const activeHint = computed(() => TOOLS.find((t) => t.key === tool.value)?.hint ?? "");

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
  stroke: "#8a38f5", strokeWidth: 2, fillEnabled: false, draggable: false,
}));
const movableImageConfig = computed(() => ({
  image: htmlImg.value, x: imgT.x, y: imgT.y, width: imgT.width, height: imgT.height, draggable: true,
}));
const transformerConfig = {
  rotateEnabled: false, keepRatio: false, flipEnabled: false,
  enabledAnchors: ANCHORS, anchorSize: 14, anchorStroke: "#8a38f5",
  anchorFill: "#ffffff", anchorCornerRadius: 7, borderStroke: "#8a38f5", borderStrokeWidth: 2,
  boundBoxFunc: frameBound,
};
const imgTransformerConfig = {
  rotateEnabled: false, keepRatio: true, flipEnabled: false,
  enabledAnchors: ["top-left", "top-right", "bottom-left", "bottom-right"],
  anchorSize: 14, anchorStroke: "#8a38f5", anchorFill: "#ffffff",
  anchorCornerRadius: 7, borderStroke: "#8a38f5", borderStrokeWidth: 2, boundBoxFunc: imgBound,
};
const maskLines = computed(() =>
  strokes.value.map((s) => ({
    points: srcPointsToDisplay(s.points),
    stroke: inpaintMode.value === "erase" ? "rgba(245,80,80,0.55)" : "rgba(138,56,245,0.55)",
    strokeWidth: s.size * unit.value,
    lineCap: "round", lineJoin: "round", listening: false,
  })),
);

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
  for (let i = 0; i < pts.length; i += 2) out.push(b.x + pts[i]! * unit.value, b.y + pts[i + 1]! * unit.value);
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

function buildMaskDataUrl(): string | null {
  const n = natural.value;
  if (!n) return null;
  const c = document.createElement("canvas");
  c.width = n.width; c.height = n.height;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#000000"; ctx.fillRect(0, 0, n.width, n.height);
  ctx.strokeStyle = "#ffffff"; ctx.fillStyle = "#ffffff";
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (const s of strokes.value) {
    const p = s.points;
    if (p.length < 2) continue;
    ctx.lineWidth = s.size;
    if (p.length === 2) {
      ctx.beginPath(); ctx.arc(p[0]!, p[1]!, s.size / 2, 0, Math.PI * 2); ctx.fill();
      continue;
    }
    ctx.beginPath(); ctx.moveTo(p[0]!, p[1]!);
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
  return "Применить";
});

// Close the modal automatically once a successful op reports its "Готово" message.
watch(() => props.msg, (m) => {
  if (m && open.value) closeEditor();
});

// ---- Modal open/close + stage measuring ----
let ro: ResizeObserver | null = null;
function measure() {
  const el = stageWrapRef.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (r.width > 0) stage.w = Math.round(r.width);
  if (r.height > 0) stage.h = Math.round(r.height);
  if (natural.value) resetScene();
}
function openEditor() {
  if (!props.image) return;
  open.value = true;
  tool.value = "expand";
  nextTick(() => {
    measure();
    if (typeof ResizeObserver !== "undefined" && stageWrapRef.value) {
      ro = new ResizeObserver(measure);
      ro.observe(stageWrapRef.value);
    }
  });
}
function closeEditor() {
  open.value = false;
  ro?.disconnect();
  ro = null;
}

// ---- Lifecycle ----
function probe() {
  natural.value = null;
  htmlImg.value = null;
  if (!import.meta.client || !props.image) return;
  const im = new Image();
  im.onload = () => {
    natural.value = { width: im.naturalWidth, height: im.naturalHeight };
    htmlImg.value = im;
    if (open.value) resetScene();
  };
  im.src = props.image.generatedImageUrl;
}
watch(() => props.image?.id ?? null, () => {
  if (!props.image && open.value) closeEditor();
  probe();
}, { immediate: true });
watch(tool, () => {
  if (natural.value) resetScene();
});
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

onMounted(() => {
  const c = document.createElement("canvas");
  c.width = 16; c.height = 16;
  const ctx = c.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#f4f4f6"; ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = "#e0e0e6"; ctx.fillRect(0, 0, 8, 8); ctx.fillRect(8, 8, 8, 8);
  }
  checker.value = c;
});
onBeforeUnmount(() => ro?.disconnect());
</script>

<template>
  <section class="scale">
    <h2 class="scale__title">Scale image</h2>

    <p v-if="!image" class="scale__hint">
      Выберите ровно одну картинку, чтобы редактировать её: расширить края, двигать/зумить или дорисовать по маске.
    </p>

    <template v-else>
      <div class="scale__preview">
        <img :src="image.generatedImageUrl" :alt="image.brandName || ''" class="scale__thumb" />
      </div>
      <button class="scale__btn" type="button" @click="openEditor">
        <span class="scale__btn-ic" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
        Редактировать
      </button>
      <p v-if="error" class="scale__feedback scale__feedback--error">{{ error }}</p>
    </template>

    <!-- Large editor modal -->
    <Teleport to="body">
      <div v-if="open && image" class="se" @click.self="!busy && closeEditor()">
        <div class="se__panel">
          <header class="se__head">
            <h3 class="se__title">Scale — редактор изображения</h3>
            <button class="se__close" type="button" aria-label="Закрыть" :disabled="busy" @click="closeEditor">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </button>
          </header>

          <div class="se__body">
            <div ref="stageWrapRef" class="se__canvas">
              <ClientOnly>
                <v-stage v-if="natural && htmlImg && checker" :config="stageConfig">
                  <v-layer>
                    <template v-if="tool === 'expand'">
                      <v-rect :config="checkerConfig" />
                      <v-image :config="baseImageConfig" />
                      <v-rect ref="frameRef" :config="frameConfig" @transform="onFrameTransform" @transformend="onFrameTransform" />
                      <v-transformer ref="frameTrRef" :config="transformerConfig" />
                    </template>
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
                <p v-else class="se__loading">Загрузка изображения…</p>
              </ClientOnly>
            </div>

            <aside class="se__controls">
              <div class="se__tools" role="tablist">
                <button
                  v-for="t in TOOLS"
                  :key="t.key"
                  type="button"
                  :class="['se__tool', { 'se__tool--on': tool === t.key }]"
                  @click="tool = t.key"
                >{{ t.label }}</button>
              </div>

              <p class="se__toolhint">{{ activeHint }}</p>

              <div v-if="tool === 'inpaint'" class="se__group">
                <div class="se__seg">
                  <button type="button" :class="['se__seg-btn', { 'se__seg-btn--on': inpaintMode === 'fill' }]" @click="inpaintMode = 'fill'">Дорисовать</button>
                  <button type="button" :class="['se__seg-btn', { 'se__seg-btn--on': inpaintMode === 'erase' }]" @click="inpaintMode = 'erase'">Стереть</button>
                </div>
                <label class="se__brush">
                  Размер кисти: {{ brush }}px
                  <input v-model.number="brush" type="range" min="8" max="200" step="4" />
                </label>
                <button v-if="hasMask" type="button" class="se__link" @click="clearMask">Очистить маску</button>
              </div>

              <div v-else class="se__group">
                <p class="se__added">
                  {{ tool === 'expand'
                    ? `Добавлено по краям: +${pad.top + pad.right + pad.bottom + pad.left}px`
                    : 'Двигайте и масштабируйте картинку в холсте' }}
                </p>
                <button type="button" class="se__link" @click="resetScene">Сбросить</button>
              </div>

              <textarea
                v-if="tool !== 'inpaint'"
                v-model="outpaintPrompt"
                class="se__prompt"
                rows="3"
                placeholder="Что дорисовать по краям (необязательно)"
              />
              <textarea
                v-else-if="inpaintMode === 'fill'"
                v-model="inpaintPrompt"
                class="se__prompt"
                rows="3"
                placeholder="Что нарисовать в выделенной области"
              />

              <p v-if="error" class="se__feedback se__feedback--error">{{ error }}</p>

              <div class="se__actions">
                <button class="se__cancel" type="button" :disabled="busy" @click="closeEditor">Отмена</button>
                <button class="se__apply" type="button" :disabled="!canSubmit" @click="submit">{{ actionLabel }}</button>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.scale {
  display: flex;
  flex-direction: column;
  gap: 12px;
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
.scale__preview {
  display: grid;
  place-items: center;
  padding: 8px;
  border-radius: var(--radius-sm);
  background: var(--color-white);
  border: 1px solid var(--color-border);
}
.scale__thumb {
  max-width: 100%;
  max-height: 96px;
  object-fit: contain;
  border-radius: var(--radius-sm);
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
.scale__btn:hover {
  filter: brightness(1.04);
}
.scale__btn-ic {
  display: inline-grid;
  place-items: center;
}
.scale__feedback {
  margin: 0;
  font-size: 13px;
}
.scale__feedback--error {
  color: var(--color-stop-hover);
}

/* ---- editor modal ---- */
.se {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background: rgba(15, 15, 18, 0.72);
  backdrop-filter: blur(4px);
}
.se__panel {
  width: min(1100px, 96vw);
  height: min(760px, 92vh);
  display: flex;
  flex-direction: column;
  background: var(--color-white);
  border-radius: var(--radius-lg);
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
}
.se__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 22px;
  border-bottom: 1px solid var(--color-border);
}
.se__title {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  color: var(--color-text);
}
.se__close {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-white);
  color: var(--color-text);
}
.se__close:hover:not(:disabled) {
  border-color: var(--color-accent);
  color: var(--color-accent);
}
.se__body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 320px;
}
.se__canvas {
  position: relative;
  min-width: 0;
  display: grid;
  place-items: center;
  background: var(--color-segment);
  touch-action: none;
  overflow: hidden;
}
.se__loading {
  margin: 0;
  color: var(--color-grey);
  font-size: 14px;
}
.se__controls {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
  border-left: 1px solid var(--color-border);
  overflow-y: auto;
}
.se__tools {
  display: inline-flex;
  padding: 3px;
  border-radius: var(--radius-pill);
  background: var(--color-segment);
  gap: 2px;
}
.se__tool {
  flex: 1;
  border: none;
  background: transparent;
  padding: 8px 10px;
  border-radius: var(--radius-pill);
  font-family: inherit;
  font-size: 12px;
  color: var(--color-grey);
}
.se__tool--on {
  background: var(--color-white);
  color: var(--color-text);
  box-shadow: var(--shadow-card);
}
.se__toolhint {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--color-grey);
}
.se__group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.se__seg {
  display: inline-flex;
  padding: 3px;
  border-radius: var(--radius-pill);
  background: var(--color-segment);
  gap: 2px;
}
.se__seg-btn {
  flex: 1;
  border: none;
  background: transparent;
  padding: 8px 10px;
  border-radius: var(--radius-pill);
  font-family: inherit;
  font-size: 12px;
  color: var(--color-grey);
}
.se__seg-btn--on {
  background: var(--color-white);
  color: var(--color-text);
  box-shadow: var(--shadow-card);
}
.se__brush {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--color-grey);
}
.se__brush input {
  accent-color: var(--color-accent);
}
.se__added {
  margin: 0;
  font-size: 12px;
  color: var(--color-grey);
}
.se__link {
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: 12px;
  color: var(--color-accent);
  padding: 0;
  align-self: flex-start;
}
.se__link:hover {
  text-decoration: underline;
}
.se__prompt {
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
.se__prompt:focus {
  border-color: var(--color-accent);
}
.se__feedback {
  margin: 0;
  font-size: 13px;
}
.se__feedback--error {
  color: var(--color-stop-hover);
}
.se__actions {
  margin-top: auto;
  display: flex;
  gap: 10px;
}
.se__cancel {
  flex: 0 0 auto;
  padding: 12px 18px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-white);
  font-family: inherit;
  font-size: 14px;
  color: var(--color-text);
}
.se__cancel:hover:not(:disabled) {
  border-color: var(--color-accent);
  color: var(--color-accent);
}
.se__apply {
  flex: 1;
  padding: 12px 18px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--gradient-active);
  color: var(--color-white);
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
}
.se__apply:hover:not(:disabled) {
  filter: brightness(1.04);
}
.se__apply:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 720px) {
  .se__body {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr auto;
  }
  .se__controls {
    border-left: none;
    border-top: 1px solid var(--color-border);
  }
}
</style>
