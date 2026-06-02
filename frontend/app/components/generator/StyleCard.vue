<script setup lang="ts">
// One "Style Title" reference card — interactive (R2). Used once in All mode
// (targetKey = null → global prompt / quantity / refs) and repeated per selected
// style in Each mode (targetKey = brandId / style name → per-target state).
// Uploaded references are read to base64 data URLs and previewed in the slots.
const props = withDefaults(
  defineProps<{ targetKey: string | null; title: string; example?: string }>(),
  { example: "" },
);

const gen = useGeneratorStore();

const MAX_REFS = 3;
const MIN_QTY = 1;
const MAX_QTY = 4;

const prompt = computed<string>({
  get: () => (props.targetKey === null ? gen.prompt : gen.targetPrompts[props.targetKey] ?? ""),
  set: (v) =>
    props.targetKey === null ? (gen.prompt = v) : gen.setTargetPrompt(props.targetKey, v),
});

const quantity = computed<number>({
  get: () => (props.targetKey === null ? gen.imageCount : gen.targetCount(props.targetKey)),
  set: (v) =>
    props.targetKey === null ? (gen.imageCount = v) : gen.setTargetCount(props.targetKey, v),
});

const refs = computed<string[]>({
  get: () => (props.targetKey === null ? gen.refImages : gen.targetRefs(props.targetKey)),
  set: (v) =>
    props.targetKey === null ? (gen.refImages = v) : gen.setTargetRefs(props.targetKey, v),
});

function onFiles(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  for (const file of files) {
    if (refs.value.length >= MAX_REFS) break;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string" && refs.value.length < MAX_REFS) {
        refs.value = [...refs.value, reader.result];
      }
    };
    reader.readAsDataURL(file);
  }
  input.value = ""; // allow re-picking the same file
}
function removeRef(i: number) {
  refs.value = refs.value.filter((_, idx) => idx !== i);
}
function setQty(n: number) {
  quantity.value = Math.min(MAX_QTY, Math.max(MIN_QTY, n));
}

// Aspect ratio (R5) — bound to the store like prompt/quantity/refs.
const aspect = computed<string>({
  get: () => (props.targetKey === null ? gen.aspectRatio : gen.targetAspect(props.targetKey)),
  set: (v) =>
    props.targetKey === null ? (gen.aspectRatio = v) : gen.setTargetAspect(props.targetKey, v),
});

const ASPECTS = [
  { value: "1:1", icon: "square" },
  { value: "9:16", icon: "portrait" },
] as const;
</script>

<template>
  <div class="style">
    <span class="style__label">{{ title }}</span>

    <!-- reference images: previews + upload control -->
    <div class="style__slots">
      <div v-for="(src, i) in refs" :key="i" class="slot slot--filled">
        <img class="slot__img" :src="src" alt="reference" />
        <button
          class="slot__remove"
          type="button"
          aria-label="Remove image"
          @click="removeRef(i)"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <label v-if="refs.length < MAX_REFS" class="slot slot--add">
        <input class="slot__file" type="file" accept="image/*" multiple @change="onFiles" />
        <span class="slot__plus" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
            <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </span>
      </label>
    </div>

    <!-- prompt -->
    <textarea
      v-model="prompt"
      class="style__prompt"
      :placeholder="example ? `Example: ${example}` : 'Describe the action / scene…'"
      rows="3"
    />

    <!-- quantity + format hints -->
    <div class="style__formats">
      <div class="qty" role="group" aria-label="Quantity of images to generate">
        <button
          class="qty__btn"
          type="button"
          aria-label="Decrease"
          :disabled="quantity <= MIN_QTY"
          @click="setQty(quantity - 1)"
        >−</button>
        <span class="qty__val">{{ quantity }}</span>
        <button
          class="qty__btn"
          type="button"
          aria-label="Increase"
          :disabled="quantity >= MAX_QTY"
          @click="setQty(quantity + 1)"
        >+</button>
      </div>

      <button
        v-for="a in ASPECTS"
        :key="a.value"
        type="button"
        :class="['fmt', { 'fmt--on': aspect === a.value }]"
        :aria-pressed="aspect === a.value"
        @click="aspect = a.value"
      >
        <span class="fmt__ic" aria-hidden="true">
          <svg v-if="a.icon === 'square'" viewBox="0 0 24 24" width="13" height="13" fill="none">
            <rect x="5" y="5" width="14" height="14" rx="2" stroke="currentColor" stroke-width="1.6" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="13" height="13" fill="none">
            <rect x="7" y="4" width="10" height="16" rx="2" stroke="currentColor" stroke-width="1.6" />
          </svg>
        </span>
        {{ a.value }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.style {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 18px;
  background: var(--color-white);
}
.style__label {
  font-size: 13px;
  color: var(--color-grey);
  margin-bottom: 14px;
}

/* reference slots */
.style__slots {
  display: flex;
  gap: 14px;
}
.slot {
  position: relative;
  width: 110px;
  height: 110px;
  border-radius: var(--radius-sm);
  background: var(--color-bubble);
  overflow: hidden;
}
.slot__img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.slot__remove {
  position: absolute;
  top: 6px;
  right: 6px;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--radius-xs);
  background: rgba(31, 31, 31, 0.6);
  color: var(--color-white);
  cursor: pointer;
}
.slot__remove:hover {
  background: var(--color-stop);
}
.slot--add {
  display: grid;
  place-items: center;
  cursor: pointer;
  border: 1px dashed var(--color-border);
  background: var(--color-white);
  color: var(--color-grey);
}
.slot--add:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
}
.slot__file {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.slot__plus {
  pointer-events: none;
}

/* prompt */
.style__prompt {
  margin-top: 16px;
  width: 100%;
  min-height: 64px;
  resize: vertical;
  padding: 12px 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-white);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--color-text);
  outline: none;
}
.style__prompt::placeholder {
  color: var(--color-grey);
}
.style__prompt:focus {
  border-color: var(--color-accent);
}

/* quantity + format chips row */
.style__formats {
  /* margin-top:auto pushes this row to the bottom when the card grows (All mode);
     in the compact Each cards it just sits after the prompt. */
  margin-top: auto;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding-top: 16px;
}
.qty {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-right: auto;
  padding: 4px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-white);
}
.qty__btn {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 50%;
  background: var(--color-bubble);
  color: var(--color-text);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.qty__btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.qty__btn:not(:disabled):hover {
  background: var(--color-window);
}
.qty__val {
  min-width: 18px;
  text-align: center;
  font-size: 13px;
  color: var(--color-text);
}
.fmt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: var(--radius-pill);
  background: var(--color-window);
  border: 1px solid var(--color-border);
  font-family: inherit;
  font-size: 12px;
  color: var(--color-grey);
  cursor: pointer;
}
.fmt:hover {
  border-color: var(--color-accent);
}
.fmt--on {
  background: var(--color-white);
  border-color: var(--color-accent);
  color: var(--color-text);
}
.fmt__ic {
  display: inline-grid;
  place-items: center;
}
</style>
