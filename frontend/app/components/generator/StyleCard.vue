<script setup lang="ts">
// One "Style Title" reference card (home 2.0 new / Each mockups): label +
// reference upload slots + prompt. Used once in All mode (targetKey = null →
// global prompt/refs, rendered flat) and per selected style in Each mode
// (targetKey = brandId / style name → per-target state, bordered grid cell).
// Format and quantity moved to the shared controls row in ReferencePanel —
// the backend falls back per-target → global, so Each cards inherit them.
const props = withDefaults(
  defineProps<{ targetKey: string | null; title: string; example?: string; flat?: boolean }>(),
  { example: "", flat: false },
);

const gen = useGeneratorStore();

const MAX_REFS = 3;

const prompt = computed<string>({
  get: () => (props.targetKey === null ? gen.prompt : gen.targetPrompts[props.targetKey] ?? ""),
  set: (v) =>
    props.targetKey === null ? (gen.prompt = v) : gen.setTargetPrompt(props.targetKey, v),
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
</script>

<template>
  <div :class="['style', { 'style--flat': flat }]">
    <!-- label + upload slots; in All mode this block sits on a grey panel
         (mock: #F7F7F7 rounded box around Style Title + slot) -->
    <div class="style__head">
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
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
              <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            </svg>
          </span>
        </label>
      </div>
    </div>

    <!-- prompt -->
    <textarea
      v-model="prompt"
      class="style__prompt"
      :placeholder="example ? `Example:\n${example}` : 'Describe the action / scene…'"
      rows="3"
    />
  </div>
</template>

<style scoped>
.style {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 16px;
  background: var(--color-white);
}
/* All mode: the single card sits directly on the board, no own frame */
.style--flat {
  border: none;
  border-radius: 0;
  padding: 0;
  background: none;
  min-height: 0;
}
.style__head {
  display: flex;
  flex-direction: column;
}
/* All mode: grey panel around the label + upload slots (mock: #F7F7F7,
   1px #E5E5E5, radius 14) */
.style--flat .style__head {
  background: var(--color-window);
  border: 1px solid var(--color-bubble);
  border-radius: var(--radius-md);
  padding: 14px 16px 16px;
}
.style__label {
  font-size: var(--fs-user); /* 14px, dark — as in the mock ("Style Title") */
  color: var(--color-text);
  margin-bottom: 12px;
}

/* reference slots */
.style__slots {
  display: flex;
  gap: 12px;
}
.slot {
  position: relative;
  width: 78px;
  height: 78px;
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
  color: #ffffff;
  cursor: pointer;
}
.slot__remove:hover {
  background: var(--color-stop);
}
.slot--add {
  display: grid;
  place-items: center;
  cursor: pointer;
  border: 1px solid var(--color-border);
  background: var(--color-window); /* mock: slot blends with the grey panel */
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
  margin-top: 14px;
  width: 100%;
  min-height: 56px;
  resize: vertical;
  padding: 12px 14px;
  border: 1px solid var(--color-bubble); /* mock: #E5E5E5 */
  border-radius: var(--radius-sm);
  background: var(--color-white);
  font-family: inherit;
  font-size: var(--fs-tab); /* 12px — Descriptor Large */
  line-height: 1.5;
  color: var(--color-text);
  outline: none;
}
/* All mode: the prompt grows to fill the panel height (per mockup) */
.style--flat .style__prompt {
  flex: 1;
  min-height: 96px;
  resize: none;
}
.style__prompt::placeholder {
  color: var(--color-grey);
  white-space: pre-line;
}
.style__prompt:focus {
  border-color: var(--color-accent);
}
</style>
