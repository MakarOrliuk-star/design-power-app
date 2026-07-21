<script setup lang="ts">
// Image Bundles — Result screen center column (figma/crm-bundle/result.PNG):
// project header + ✎ Edit, meta row, "Generated bundles by brand" accordion
// with per-asset cards (image, Approved badge, Edit / Regenerate / Approve).
// Renders dynamically while assets finish (store polling). Sizes come from
// the bundle type config — canonical mask sizes, D2.
import { ref, computed, watch } from "vue";

const store = useBundlesStore();

const bundle = computed(() => store.selected);

// Accordion: the first variant starts open (mock). Reset on bundle switch.
const openVariants = ref<Set<string>>(new Set());
watch(
  () => bundle.value?.id,
  () => {
    openVariants.value = new Set(bundle.value?.variants[0] ? [bundle.value.variants[0].id] : []);
  },
  { immediate: true },
);

function toggleVariant(id: string) {
  const next = new Set(openVariants.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  openVariants.value = next;
}

// ✎ Edit modal (project name / planned date / prompt — PATCH, D9 header edit).
const editOpen = ref(false);
const editName = ref("");
const editDate = ref("");
const editPrompt = ref("");
const saving = ref(false);

function openEdit() {
  if (!bundle.value) return;
  editName.value = bundle.value.name;
  editDate.value = bundle.value.plannedSendAt ? toLocalInput(bundle.value.plannedSendAt) : "";
  editPrompt.value = bundle.value.neuralPrompt;
  editOpen.value = true;
}

async function saveEdit() {
  if (!editName.value.trim()) return;
  saving.value = true;
  const ok = await store.updateBundle({
    name: editName.value.trim(),
    plannedSendAt: editDate.value ? new Date(editDate.value).toISOString() : null,
    neuralPrompt: editPrompt.value,
  });
  saving.value = false;
  if (ok) editOpen.value = false;
}

// Per-asset Edit modal (D9: text img2img edit of the current image).
const assetEditId = ref<string | null>(null);
const assetEditPrompt = ref("");

function openAssetEdit(assetId: string) {
  assetEditId.value = assetId;
  assetEditPrompt.value = "";
}

async function submitAssetEdit() {
  if (!assetEditId.value || !assetEditPrompt.value.trim()) return;
  saving.value = true;
  const ok = await store.editAsset(assetEditId.value, assetEditPrompt.value.trim());
  saving.value = false;
  if (ok) assetEditId.value = null;
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} at ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}
</script>

<template>
  <section v-if="bundle" class="result">
    <!-- Project header + meta -->
    <header class="head">
      <span class="head__icon">📦</span>
      <div class="head__main">
        <h2 class="head__title">{{ bundle.name }}</h2>
        <p class="head__meta">
          <span>Bundle type: <b>{{ bundle.bundleType.title }}</b></span>
          <span>Planned send date: <b>{{ formatDateTime(bundle.plannedSendAt) }}</b></span>
          <span class="head__prompt">Neural prompt: <b>{{ bundle.neuralPrompt || "—" }}</b></span>
        </p>
      </div>
      <button class="btn btn--ghost" type="button" @click="openEdit">✎ Edit</button>
    </header>

    <p v-if="store.actionError" class="result__error">
      {{ store.actionError === "queue_unavailable" ? "Очередь генерации недоступна — попробуйте позже." : "Действие не выполнено, попробуйте ещё раз." }}
    </p>

    <h3 class="result__section">Generated bundles by brand</h3>

    <div class="variants">
      <article v-for="v in bundle.variants" :key="v.id" class="variant" :class="{ 'variant--open': openVariants.has(v.id) }">
        <button class="variant__head" type="button" @click="toggleVariant(v.id)">
          <span class="variant__avatar">{{ v.displayName.slice(0, 1).toUpperCase() }}</span>
          <span class="variant__name">{{ v.displayName }}</span>
          <span
            class="variant__badge"
            :class="{ 'variant__badge--full': v.approvedCount === v.assets.length && v.assets.length > 0 }"
          >
            {{ v.approvedCount }} of {{ v.assets.length }} approved
          </span>
          <svg class="variant__chevron" viewBox="0 0 24 24" width="16" height="16" fill="none">
            <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>

        <div v-if="openVariants.has(v.id)" class="variant__body">
          <p class="variant__subtitle">
            <span class="variant__radio" aria-hidden="true" />
            <b>{{ bundle.bundleType.title }}</b>
          </p>
          <div class="cards">
            <div
              v-for="a in v.assets"
              :key="a.id"
              class="asset"
              :class="{ 'asset--selected': store.selectedAssetIds.has(a.id) }"
            >
              <header class="asset__head">
                <span class="asset__label">
                  <b>{{ a.label }}</b>
                  <small>{{ a.width }}×{{ a.height }}</small>
                </span>
                <span v-if="a.approved" class="asset__approved">✓ Approved</span>
                <label v-else-if="a.status === 'done'" class="asset__select" title="Select for batch approve">
                  <input
                    type="checkbox"
                    :checked="store.selectedAssetIds.has(a.id)"
                    @change="store.toggleAssetSelection(a.id)"
                  />
                </label>
              </header>

              <div class="asset__frame" :style="{ aspectRatio: `${a.width} / ${a.height}` }">
                <img v-if="a.imageUrl && a.status === 'done'" :src="a.imageUrl" :alt="`${v.displayName} ${a.label}`" loading="lazy" />
                <div v-else-if="a.status === 'generating' || a.status === 'pending'" class="asset__placeholder">
                  <span class="spinner" />
                  <small>{{ a.status === "pending" ? "Queued…" : "Generating…" }}</small>
                </div>
                <div v-else class="asset__placeholder asset__placeholder--failed">
                  <small>⚠ {{ a.errorMessage || "Generation failed" }}</small>
                </div>
              </div>

              <footer class="asset__actions">
                <button
                  class="btn btn--sm"
                  type="button"
                  :disabled="a.status !== 'done'"
                  @click="openAssetEdit(a.id)"
                >✎ Edit</button>
                <button
                  class="btn btn--sm"
                  type="button"
                  :disabled="a.status === 'generating' || a.status === 'pending'"
                  @click="store.regenerateAsset(a.id)"
                >⟳ Regenerate</button>
                <button
                  class="btn btn--sm"
                  :class="{ 'btn--approved': a.approved }"
                  type="button"
                  :disabled="a.status !== 'done'"
                  @click="store.approveAssets([a.id], !a.approved)"
                >✓ {{ a.approved ? "Approved" : "Approve" }}</button>
              </footer>
            </div>
          </div>
        </div>
      </article>
    </div>

    <!-- Project edit modal -->
    <div v-if="editOpen" class="modal" @click.self="editOpen = false">
      <div class="modal__box">
        <h3 class="modal__title">Edit project</h3>
        <label class="modal__field">
          <span>Project name</span>
          <input v-model="editName" type="text" maxlength="200" />
        </label>
        <label class="modal__field">
          <span>Planned send date</span>
          <input v-model="editDate" type="datetime-local" />
        </label>
        <label class="modal__field">
          <span>Neural prompt <small>(applies to future regenerates)</small></span>
          <textarea v-model="editPrompt" rows="4" maxlength="1500" />
        </label>
        <div class="modal__actions">
          <button class="btn btn--ghost" type="button" @click="editOpen = false">Cancel</button>
          <button class="btn btn--primary" type="button" :disabled="saving || !editName.trim()" @click="saveEdit">Save</button>
        </div>
      </div>
    </div>

    <!-- Asset edit modal (text prompt img2img, D9) -->
    <div v-if="assetEditId" class="modal" @click.self="assetEditId = null">
      <div class="modal__box">
        <h3 class="modal__title">Edit asset</h3>
        <label class="modal__field">
          <span>What should change?</span>
          <textarea
            v-model="assetEditPrompt"
            rows="4"
            maxlength="1500"
            placeholder="e.g. Make the background warmer and add more golden coins on the left"
          />
        </label>
        <p class="modal__hint">Правка применяется к текущей картинке (размер холста сохраняется); статус аппрува будет сброшен.</p>
        <div class="modal__actions">
          <button class="btn btn--ghost" type="button" @click="assetEditId = null">Cancel</button>
          <button class="btn btn--primary" type="button" :disabled="saving || !assetEditPrompt.trim()" @click="submitAssetEdit">Apply edit</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.result {
  display: flex;
  flex-direction: column;
  gap: 16px;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  padding: 22px;
  min-height: 0;
  overflow-y: auto;
}
.result__error {
  margin: 0;
  color: var(--color-stop-hover);
  font-size: 12.5px;
}
.result__section {
  margin: 4px 0 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
}

.head {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}
.head__icon {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  font-size: 20px;
}
.head__main {
  flex: 1;
  min-width: 0;
}
.head__title {
  margin: 0;
  font-size: 19px;
  color: var(--color-text);
}
.head__meta {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--color-grey);
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.head__meta b {
  color: var(--color-text);
  font-weight: 600;
}
.head__prompt {
  max-width: 420px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.btn {
  border: 1px solid var(--color-border);
  background: none;
  color: var(--color-text);
  border-radius: var(--radius-sm);
  padding: 8px 14px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.btn:hover:not(:disabled) {
  border-color: var(--color-accent);
}
.btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.btn--sm {
  padding: 6px 10px;
  font-size: 11.5px;
  flex: 1;
}
.btn--primary {
  background: var(--gradient-active, var(--color-accent));
  border: none;
  color: #fff;
}
.btn--approved {
  border-color: #16a34a;
  color: #16a34a;
}

.variants {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.variant {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}
.variant--open {
  border-color: var(--color-accent);
}
.variant__head {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  border: none;
  background: none;
  padding: 12px 14px;
  cursor: pointer;
  text-align: left;
}
.variant__avatar {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--color-segment);
  font-size: 12px;
  font-weight: 700;
  color: var(--color-text);
}
.variant__name {
  flex: 1;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--color-text);
}
.variant__badge {
  font-size: 10.5px;
  font-weight: 600;
  border-radius: var(--radius-pill);
  padding: 3px 9px;
  background: var(--color-segment);
  color: var(--color-grey);
}
.variant__badge--full {
  background: #dcfce7;
  color: #16a34a;
}
.variant__chevron {
  color: var(--color-grey);
  transition: transform 0.15s ease;
}
.variant--open .variant__chevron {
  transform: rotate(180deg);
}
.variant__body {
  padding: 0 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.variant__subtitle {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--color-text);
}
.variant__radio {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 4px solid var(--color-accent);
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 12px;
}
.asset {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 10px;
}
.asset--selected {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 1px var(--color-accent);
}
.asset__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.asset__label {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.asset__label b {
  font-size: 12.5px;
  color: var(--color-text);
}
.asset__label small {
  font-size: 10.5px;
  color: var(--color-grey);
}
.asset__approved {
  font-size: 10.5px;
  font-weight: 600;
  color: #16a34a;
  background: #dcfce7;
  border-radius: var(--radius-pill);
  padding: 3px 8px;
}
:global(.dark) .asset__approved,
:global(.dark) .variant__badge--full {
  background: rgba(22, 163, 74, 0.18);
}
.asset__select input {
  width: 15px;
  height: 15px;
  accent-color: var(--color-accent);
  cursor: pointer;
}
.asset__frame {
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--color-segment);
  display: grid;
  place-items: center;
}
.asset__frame img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.asset__placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: var(--color-grey);
  font-size: 11px;
  padding: 12px;
  text-align: center;
}
.asset__placeholder--failed {
  color: var(--color-stop-hover);
}
.spinner {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-accent);
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
.asset__actions {
  display: flex;
  gap: 6px;
}

.modal {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(0, 0, 0, 0.45);
  display: grid;
  place-items: center;
  padding: 20px;
}
.modal__box {
  width: min(520px, 100%);
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.modal__title {
  margin: 0;
  font-size: 16px;
  color: var(--color-text);
}
.modal__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--color-text);
}
.modal__field small {
  font-weight: 400;
  color: var(--color-grey);
}
.modal__field input,
.modal__field textarea {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: none;
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
  padding: 9px 11px;
  outline: none;
}
.modal__field input:focus,
.modal__field textarea:focus {
  border-color: var(--color-accent);
}
.modal__hint {
  margin: 0;
  font-size: 11.5px;
  color: var(--color-grey);
}
.modal__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
