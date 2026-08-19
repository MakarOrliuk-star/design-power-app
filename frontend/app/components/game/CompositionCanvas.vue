<script setup lang="ts">
// Composition preview (TASK game-manager, Phase 2).
//
// The stencil is drawn from the SAME numbers the renderer uses — guides,
// circles and the person box all come from stores/game.ts helpers, which mirror
// backend/src/lib/gameTemplate.ts. That is deliberate: a preview that computes
// placement its own way is a preview that lies about what Save will produce.
//
// The box is a true 9:16 (Q7) at the mock's 540px height. The Figma preview is
// drawn 324x540 (3:5); its stencil circles are width-derived, so they carry
// over unchanged — see R-PLAN-game-manager.md §2.1.
import { previewPersonBox, stencilCircles, stencilGuides } from "~/stores/game";

const game = useGameStore();

const spec = computed(() => game.template?.spec ?? null);
const canvasW = computed(() => game.template?.canvasW ?? 1080);
const canvasH = computed(() => game.template?.canvasH ?? 1920);

const guides = computed(() =>
  spec.value ? stencilGuides(spec.value, canvasW.value, canvasH.value) : null,
);
const circles = computed(() =>
  spec.value ? stencilCircles(spec.value, canvasW.value, canvasH.value) : null,
);

/** Percentages for inline styles — the box scales, the geometry doesn't. */
const pct = (v: number) => `${(v * 100).toFixed(4)}%`;

const personStyle = computed(() => {
  const person = game.person;
  if (!person || !spec.value) return null;
  const box = previewPersonBox(
    spec.value,
    person.width,
    person.height,
    canvasW.value,
    canvasH.value,
    game.scale,
  );
  return {
    left: pct(box.left),
    top: pct(box.top),
    width: pct(box.width),
    height: pct(box.height),
  };
});

// Q10: the checkbox switches the blur on, the slider sets its radius. The
// preview approximates it with a CSS filter scaled to the preview size, so the
// number on screen means the same thing as the sigma sent to sharp.
const backgroundStyle = computed(() => {
  if (!game.background) return null;
  const previewScale = 304 / canvasW.value; // preview width / real canvas width
  return {
    backgroundImage: `url(${JSON.stringify(game.background.url)})`,
    filter: game.blur ? `blur(${(game.blurSigma * previewScale).toFixed(2)}px)` : "none",
  };
});
</script>

<template>
  <div class="canvas">
    <!-- background layer -->
    <div v-if="backgroundStyle" class="canvas__bg" :style="backgroundStyle" />

    <!-- person layer, placed by the shared stencil maths -->
    <img
      v-if="game.person && personStyle"
      class="canvas__person"
      :src="game.person.url"
      :alt="game.person.name"
      :style="personStyle"
    />

    <!-- stencil overlay -->
    <svg v-if="guides && circles" class="canvas__stencil" viewBox="0 0 100 100" preserveAspectRatio="none">
      <line
        v-for="(x, i) in guides.vertical"
        :key="`v${i}`"
        :x1="x * 100"
        :x2="x * 100"
        y1="0"
        y2="100"
        vector-effect="non-scaling-stroke"
      />
      <line
        v-for="(y, i) in guides.horizontal"
        :key="`h${i}`"
        x1="0"
        x2="100"
        :y1="y * 100"
        :y2="y * 100"
        vector-effect="non-scaling-stroke"
      />
      <ellipse
        :cx="circles.outer.cx * 100"
        :cy="circles.outer.cy * 100"
        :rx="circles.outer.rx * 100"
        :ry="circles.outer.ry * 100"
        vector-effect="non-scaling-stroke"
      />
      <ellipse
        :cx="circles.inner.cx * 100"
        :cy="circles.inner.cy * 100"
        :rx="circles.inner.rx * 100"
        :ry="circles.inner.ry * 100"
        vector-effect="non-scaling-stroke"
      />
    </svg>
  </div>
</template>

<style scoped>
.canvas {
  position: relative;
  /* mock: 540px tall; 9:16 fixes the width at 303.75 (Q7) */
  height: 540px;
  aspect-ratio: 9 / 16;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-white);
  overflow: hidden;
  flex: 0 0 auto;
}
.canvas__bg {
  position: absolute;
  /* the blur is drawn inside the box, so the layer is oversized to keep its
     softened edge off-screen instead of showing a pale frame */
  inset: -6%;
  background-size: cover;
  background-position: center;
}
.canvas__person {
  position: absolute;
  object-fit: contain;
}
.canvas__stencil {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.canvas__stencil line,
.canvas__stencil ellipse {
  fill: none;
  stroke: var(--color-border);
  stroke-width: 1;
}
</style>
