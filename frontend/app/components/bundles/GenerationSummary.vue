<script setup lang="ts">
// Image Bundles — right "Generation summary" panel (result.PNG): status,
// brands / bundle type / assets counters, prompt preview with copy, and the
// Approve selected / Regenerate all / Send to Smartico actions.
import { ref, computed } from "vue";

const store = useBundlesStore();
const bundle = computed(() => store.selected);

const copied = ref(false);
async function copyPrompt() {
  if (!bundle.value?.neuralPrompt) return;
  try {
    await navigator.clipboard.writeText(bundle.value.neuralPrompt);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    /* clipboard unavailable — ignore */
  }
}

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  generating: "Generating",
  completed: "Completed",
  failed: "Failed",
};

const selectedCount = computed(() => store.selectedAssetIds.size);

// Smartico snippets modal (Phase 6): per-block copy, same UX as Unique Smartico.
const copiedBlock = ref<number | null>(null);
async function copyBlock(code: string, index: number) {
  try {
    await navigator.clipboard.writeText(code);
    copiedBlock.value = index;
    setTimeout(() => (copiedBlock.value = null), 1500);
  } catch {
    /* clipboard unavailable — ignore */
  }
}
</script>

<template>
  <aside v-if="bundle" class="summary">
    <h3 class="summary__title">Generation summary</h3>

    <dl class="summary__list">
      <div class="row">
        <dt>Generation status</dt>
        <dd :class="`row__status row__status--${bundle.status}`">{{ STATUS_LABEL[bundle.status] }}</dd>
      </div>
      <div class="row">
        <dt>Brands</dt>
        <dd>{{ bundle.summary.variantCount }}</dd>
      </div>
      <div class="row">
        <dt>Bundle type</dt>
        <dd>{{ bundle.bundleType.title }}</dd>
      </div>
      <div class="row">
        <dt>Assets generated</dt>
        <dd>
          {{ bundle.summary.assetDone }}
          <small class="row__sub">{{ bundle.summary.variantCount }} brands × {{ bundle.bundleType.assets.length }} assets</small>
        </dd>
      </div>
      <div class="row row--prompt">
        <dt>
          Neural prompt
          <button class="copy" type="button" :title="copied ? 'Copied!' : 'Copy prompt'" @click="copyPrompt">
            {{ copied ? "✓" : "⧉" }}
          </button>
        </dt>
        <dd class="row__prompt">{{ bundle.neuralPrompt || "—" }}</dd>
      </div>
    </dl>

    <div class="summary__actions">
      <button
        class="btn btn--outline"
        type="button"
        :disabled="selectedCount === 0"
        @click="store.approveAssets([...store.selectedAssetIds])"
      >
        ✓ Approve selected ({{ selectedCount }})
      </button>
      <button
        class="btn btn--outline"
        type="button"
        :disabled="bundle.status === 'generating'"
        @click="store.regenerateAll()"
      >
        ⟳ Regenerate all
      </button>
      <button
        class="btn btn--primary"
        type="button"
        :disabled="bundle.summary.approvedCount === 0 || store.sendState === 'sending'"
        @click="store.sendToSmartico()"
      >
        {{ store.sendState === "sending" ? "Sending…" : "✈ Send to Smartico" }}
      </button>
      <p v-if="store.sendState === 'no_approved'" class="summary__note summary__note--warn">
        Нет одобренных ассетов — сначала нажмите Approve.
      </p>
      <p v-else-if="store.sendState === 'error'" class="summary__note summary__note--warn">
        Не удалось отправить — попробуйте позже.
      </p>
    </div>

    <!-- Smartico result modal: stats + paste-ready functions with copy -->
    <div v-if="store.sendResult" class="smodal" @click.self="store.clearSendResult()">
      <div class="smodal__box">
        <header class="smodal__head">
          <h3>Smartico functions ready</h3>
          <button class="smodal__close" type="button" aria-label="Close" @click="store.clearSendResult()">✕</button>
        </header>
        <p class="smodal__stats">
          ↑ {{ store.sendResult.stats.uploaded }} uploaded · ♻ {{ store.sendResult.stats.reused }} reused
          <template v-if="store.sendResult.stats.failed"> · ✗ {{ store.sendResult.stats.failed }} failed</template>
        </p>
        <p v-if="store.sendResult.stats.suspicious.length" class="smodal__warn">
          ⚠ Не найдены в таблице Smartico-брендов (проверьте имена): {{ store.sendResult.stats.suspicious.join(", ") }}
        </p>
        <p v-if="store.sendResult.stats.failedItems.length" class="smodal__warn">
          ✗ {{ store.sendResult.stats.failedItems.join("; ") }}
        </p>
        <div class="smodal__blocks">
          <section v-for="(block, i) in store.sendResult.outputs" :key="i" class="sblock">
            <header class="sblock__head">
              <b>{{ block.title }}</b>
              <button class="btn btn--outline btn--copy" type="button" @click="copyBlock(block.code, i)">
                {{ copiedBlock === i ? "✓ Copied" : "⧉ Copy" }}
              </button>
            </header>
            <pre class="sblock__code">{{ block.code }}</pre>
          </section>
        </div>
        <p class="smodal__hint">
          Вставьте функцию в поле dynamic image соответствующей кампании Smartico
          (наборы Men / Women — для соответствующих сегментов аудитории).
        </p>
      </div>
    </div>

    <p class="summary__info">
      ⓘ Approved bundles will be automatically sent to Smartico and ready for activation.
      You'll be able to track performance in Smartico after activation.
    </p>
  </aside>
</template>

<style scoped>
.summary {
  display: flex;
  flex-direction: column;
  gap: 16px;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  padding: 20px;
}
.summary__title {
  margin: 0;
  font-size: 14.5px;
  font-weight: 700;
  color: var(--color-text);
}

.summary__list {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.row {
  display: flex;
  flex-direction: column;
  gap: 3px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 10px 12px;
}
.row dt {
  font-size: 11px;
  color: var(--color-grey);
  display: flex;
  align-items: center;
  gap: 6px;
}
.row dd {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--color-text);
}
.row__sub {
  display: block;
  font-size: 10.5px;
  font-weight: 400;
  color: var(--color-grey);
}
.row__status--completed { color: #16a34a; }
.row__status--generating { color: #2563eb; }
.row__status--failed { color: #dc2626; }
.row__prompt {
  font-weight: 400;
  font-size: 12px;
  color: var(--color-text);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.copy {
  border: none;
  background: none;
  color: var(--color-grey);
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}
.copy:hover {
  color: var(--color-accent);
}

.summary__actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.btn {
  border-radius: var(--radius-md);
  padding: 11px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.btn--outline {
  border: 1px solid var(--color-border);
  background: none;
  color: var(--color-text);
}
.btn--outline:hover:not(:disabled) {
  border-color: var(--color-accent);
  color: var(--color-accent);
}
.btn--primary {
  border: none;
  background: var(--gradient-active, var(--color-accent));
  color: #fff;
}
.btn--primary:hover:not(:disabled) {
  filter: brightness(1.06);
}

.summary__note {
  margin: 0;
  font-size: 11.5px;
}
.summary__note--warn {
  color: #b45309;
}

.summary__info {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--color-grey);
  background: color-mix(in srgb, var(--color-accent) 7%, transparent);
  border-radius: var(--radius-md);
  padding: 12px;
}

/* Smartico snippets modal */
.smodal {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: rgba(0, 0, 0, 0.5);
  display: grid;
  place-items: center;
  padding: 24px;
}
.smodal__box {
  width: min(760px, 100%);
  max-height: 85vh;
  overflow-y: auto;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.smodal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.smodal__head h3 {
  margin: 0;
  font-size: 16px;
  color: var(--color-text);
}
.smodal__close {
  border: none;
  background: none;
  color: var(--color-grey);
  font-size: 15px;
  cursor: pointer;
}
.smodal__stats {
  margin: 0;
  font-size: 12.5px;
  color: var(--color-text);
}
.smodal__warn {
  margin: 0;
  font-size: 12px;
  color: #b45309;
}
.smodal__blocks {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.sblock {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.sblock__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  font-size: 12.5px;
  color: var(--color-text);
  background: var(--color-segment);
}
.btn--copy {
  padding: 5px 10px;
  font-size: 11px;
  border-radius: var(--radius-sm);
}
.sblock__code {
  margin: 0;
  padding: 12px;
  font-size: 11px;
  line-height: 1.45;
  max-height: 220px;
  overflow: auto;
  color: var(--color-text);
  background: none;
  white-space: pre;
}
.smodal__hint {
  margin: 0;
  font-size: 11.5px;
  color: var(--color-grey);
}
</style>
