<script setup lang="ts">
// Image Bundles — Result screen center column (figma/crm-bundle/result.PNG):
// project header + ✎ Edit, meta row, "Generated bundles by brand" accordion
// with per-asset cards (image, Approved badge, Edit / Regenerate / Approve).
// Renders dynamically while assets finish (store polling). Sizes come from
// the bundle type config — canonical mask sizes, D2.
import { ref, computed, watch } from "vue";
import { safeZoneStyle, safeContrast } from "~/composables/useSafeZonePreview";

const store = useBundlesStore();
const api = useApi();
const auth = useAuthStore();

const bundle = computed(() => store.selected);

// ---- Каскад стиля кампании (TASK multiformat-promo, DI2-3/DI2-9) ----
// Якорный формат (email) задаёт стиль остальным, поэтому его перегенерация
// тянет за собой push и pop-up. Правило выбора якоря повторяет серверное
// resolveStyleAnchorKey: явный флаг → "email" → первый ai_reference-ассет.
const anchorAssetKey = computed<string | null>(() => {
  const assets = (bundle.value?.bundleType.assets ?? []).filter(
    (a) => a.composeMode === "ai_reference",
  );
  if (assets.length === 0) return null;
  const explicit = assets.find((a) => a.styleAnchor === true);
  if (explicit) return explicit.key;
  return (assets.find((a) => a.key === "email") ?? assets[0])!.key;
});
const dependentLabels = computed(() =>
  (bundle.value?.bundleType.assets ?? [])
    .filter((a) => a.composeMode === "ai_reference" && a.key !== anchorAssetKey.value)
    .map((a) => a.label),
);

function isStyleAnchor(assetKey: string): boolean {
  return anchorAssetKey.value === assetKey && dependentLabels.value.length > 0;
}

/** Regenerate якоря предупреждает о каскаде — это тройная стоимость прогона. */
function regenerateWithCascade(assetKey: string, assetId: string) {
  if (isStyleAnchor(assetKey)) {
    const list = dependentLabels.value.join(" и ");
    if (
      !window.confirm(
        `${list} будут перегенерированы заново, чтобы сохранить единый стиль кампании. Продолжить?`,
      )
    )
      return;
  }
  void store.regenerateAsset(assetId);
}

// ---- Style-profile «казино-дизайнера» (DV-E1) — админский override ----
// Стиль сцены (hue плашки, материал, токены, плотность, выбор декора) — данные,
// не координаты. Сервер зажимает всё в коридоры спеки; применяется при
// СЛЕДУЮЩЕМ рендере ассета (перегенерация), в готовые картинки не лезет.
const styleEditId = ref<string | null>(null);
const styleText = ref("");
const styleMsg = ref("");
const styleBusy = ref(false);

const STYLE_TEMPLATE = {
  glowHex: "#7A1B8F",
  typoMaterial: "gold",
  tokens: ["BIG WIN"],
  density: 0.6,
};

function toggleStyleEdit(v: { id: string; styleProfile: Record<string, unknown> | null }) {
  if (styleEditId.value === v.id) {
    styleEditId.value = null;
    return;
  }
  styleEditId.value = v.id;
  styleText.value = JSON.stringify(v.styleProfile ?? STYLE_TEMPLATE, null, 2);
  styleMsg.value = "";
}

async function saveStyleProfile(reset: boolean) {
  if (!styleEditId.value) return;
  let profile: unknown = null;
  if (!reset) {
    try {
      profile = JSON.parse(styleText.value);
    } catch {
      styleMsg.value = "Невалидный JSON";
      return;
    }
  }
  styleBusy.value = true;
  try {
    await api(`/api/admin/bundle-variants/${styleEditId.value}/style-profile`, {
      method: "PATCH",
      body: { profile },
    });
    styleMsg.value = reset
      ? "Профиль сброшен — при следующей генерации бандла его снова предложит модель"
      : "Сохранено ✓ — применится при перегенерации ассетов этого бренда";
    await store.refreshSelected();
  } catch (err) {
    const details = (err as { data?: { details?: string } })?.data?.details;
    styleMsg.value = details ? `Отклонено: ${details}` : "Не удалось сохранить профиль";
  } finally {
    styleBusy.value = false;
  }
}

// ---- Safe-zone preview (TASK email-composition, Фаза 5) ----
// Engine-rendered assets ship the safe zone in percentages, so the designer can
// see the email's text block on the картинке before the письмо собрано in
// Smartico. Purely a review overlay — nothing is baked into the image (D-E1).
const safePreview = ref(false);

/**
 * Подложка превью (Задание 2, DV-A1). Ассет отдаётся прозрачным, свечение
 * внутри него — полупрозрачной плашкой, поэтому на тёмном фоне письма кадр
 * читается как эталоны 1–5 («чёрные углы»), а на светлом — как мягкая
 * заливка. Шахматка остаётся дефолтом: она показывает, где реально пусто.
 */
const BACKDROPS = [
  { key: "checker", label: "▦", title: "Шахматка — видно, где ассет прозрачный" },
  { key: "light", label: "☀", title: "Светлое письмо" },
  { key: "dark", label: "☾", title: "Тёмное письмо" },
] as const;
type BackdropKey = (typeof BACKDROPS)[number]["key"];
const backdrop = ref<BackdropKey>("checker");

const hasSafeMeta = computed(() =>
  (bundle.value?.variants ?? []).some((v) => v.assets.some((a) => a.meta)),
);


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
          <span v-if="bundle.presetTitle">Вариация: <b>{{ bundle.presetTitle }}</b></span>
          <span>Planned send date: <b>{{ formatDateTime(bundle.plannedSendAt) }}</b></span>
          <span class="head__prompt">Neural prompt: <b>{{ bundle.neuralPrompt || "—" }}</b></span>
        </p>
      </div>
      <button class="btn btn--ghost" type="button" @click="openEdit">✎ Edit</button>
    </header>

    <p v-if="store.actionError" class="result__error">
      {{ store.actionError === "queue_unavailable" ? "Очередь генерации недоступна — попробуйте позже." : "Действие не выполнено, попробуйте ещё раз." }}
    </p>

    <div class="result__sectionrow">
      <h3 class="result__section">Generated bundles by brand</h3>
      <label v-if="hasSafeMeta" class="safetoggle" title="Показать зону под текст письма и макет CTA">
        <input v-model="safePreview" type="checkbox" />
        <span>Safe zone preview</span>
      </label>
      <!-- Ассет прозрачный, и свечение внутри него читается по-разному на
           светлом и тёмном фоне письма (DV-A1). Дизайнер обязан видеть оба
           сценария, иначе «чёрные углы» проверить не на чем. -->
      <div class="backdrop" role="group" aria-label="Подложка превью">
        <button
          v-for="b in BACKDROPS"
          :key="b.key"
          type="button"
          class="backdrop__btn"
          :class="{ 'backdrop__btn--on': backdrop === b.key }"
          :title="b.title"
          @click="backdrop = b.key"
        >
          {{ b.label }}
        </button>
      </div>
    </div>

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
            <!-- DV-E1: override стиля сцены — только админ; данные, не координаты -->
            <button
              v-if="auth.isAdmin"
              class="btn btn--sm style__toggle"
              type="button"
              :title="v.styleProfile ? 'Style-profile задан' : 'Style-profile не задан (фолбэк движка)'"
              @click="toggleStyleEdit(v)"
            >
              🎨 Стиль{{ v.styleProfile ? " •" : "" }}
            </button>
          </p>

          <div v-if="auth.isAdmin && styleEditId === v.id" class="style">
            <p class="style__hint">
              Стиль сцены (DV-E1): <code>glowHex</code> #RRGGBB, <code>typoMaterial</code>
              gold/neon/gloss/silver, <code>tokens</code> ≤ 3 надписей КАПСОМ,
              <code>density</code> 0..1, <code>decorUrls</code> из библиотеки слота.
              Координат здесь нет — геометрию держит спека. Сервер зажимает значения в
              коридоры; применяется при перегенерации ассетов.
            </p>
            <textarea v-model="styleText" class="style__json" rows="8" spellcheck="false" />
            <div class="style__actions">
              <button class="btn btn--sm" type="button" :disabled="styleBusy" @click="saveStyleProfile(false)">
                Сохранить override
              </button>
              <button class="btn btn--sm btn--ghost" type="button" :disabled="styleBusy" @click="saveStyleProfile(true)">
                Сбросить к модели
              </button>
              <span v-if="styleMsg" class="style__msg">{{ styleMsg }}</span>
            </div>
          </div>
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

              <div
                class="asset__frame"
                :class="`asset__frame--${backdrop}`"
                :style="{ aspectRatio: `${a.width} / ${a.height}` }"
              >
                <img v-if="a.imageUrl && a.status === 'done'" :src="a.imageUrl" :alt="`${v.displayName} ${a.label}`" loading="lazy" />
                <div v-else-if="a.status === 'generating' || a.status === 'pending'" class="asset__placeholder">
                  <span class="spinner" />
                  <small>{{ a.status === "pending" ? "Queued…" : "Generating…" }}</small>
                </div>
                <div v-else class="asset__placeholder asset__placeholder--failed">
                  <small>⚠ {{ a.errorMessage || "Generation failed" }}</small>
                </div>

                <!-- Safe-zone overlay: mock text block as it will be laid out
                     in the письме, positioned from the asset metadata. -->
                <div
                  v-if="safePreview && a.meta?.safeZonePct && a.status === 'done' && a.imageUrl"
                  class="safe"
                  :style="safeZoneStyle(a.meta)"
                >
                  <span class="safe__up">UP TO</span>
                  <span class="safe__sum">500 000$</span>
                  <span class="safe__spins">+50 FREE SPINS</span>
                  <span class="safe__cta">Start Playing</span>
                </div>
              </div>

              <!-- Приёмка ai_reference (DI-R10 + TASK safe-zone/auto-heal, B4):
                   ни генерация, ни AI-коррекция не прошли QA — показан лучший
                   по score, решение за человеком. -->
              <p
                v-if="a.status === 'done' && a.meta?.qa && !a.meta.qa.passed"
                class="asset__qa"
                :title="a.meta.qa.reasons.join('\n') || 'Причины не указаны'"
              >
                <template v-if="a.meta.qa.healing">
                  ⚠ AI-коррекция не помогла ({{ a.meta.qa.healing.attempts }} поп.) — выбран
                  лучший вариант; картинку можно использовать, если остальное устраивает
                </template>
                <template v-else>
                  ⚠ Приёмка не пройдена — лучший из {{ a.meta.qa.attempts }}
                </template>
                <span v-if="a.meta.qa.score !== null && a.meta.qa.threshold !== null" class="asset__qa-score">
                  оценка {{ a.meta.qa.score }} / порог {{ a.meta.qa.threshold }}
                </span>
                <span v-if="a.meta.qa.reasons.length" class="asset__qa-reasons">
                  {{ a.meta.qa.reasons.join(" · ") }}
                </span>
              </p>

              <!-- Текстовый гейт (TASK no-baked-text): надпись пережила и
                   генерацию, и лечение. Ассет не падает (Спор 2 R-Plan) —
                   менеджер видит прочитанный текст и решает сам; это же
                   готовое ТЗ дизайнеру на ретушь. Показывается независимо от
                   вердикта приёмки: картинка могла пройти QA с высоким score
                   и всё равно нести «FS». -->
              <p
                v-if="a.status === 'done' && a.meta?.qa?.textGate && !a.meta.qa.textGate.clean"
                class="asset__text-gate"
                title="Детектор нашёл запечённый текст. Вариация настроена на баннеры без надписей."
              >
                ⚠ Обнаружен текст<template v-if="a.meta.qa.textGate.found">:
                  «{{ a.meta.qa.textGate.found }}»</template>
                — требуется ретушь
              </p>

              <p v-if="safePreview && a.meta" class="asset__meta">
                spec {{ a.meta.specKey }}@v{{ a.meta.specVersion }} ·
                <template v-if="a.meta.safeZonePct">
                  safe {{ Math.round(a.meta.safeZonePct.w) }}% ·
                </template>
                <template v-else>без safe-зоны ·</template>
                contrast {{ safeContrast(a.meta) }} ·
                text {{ a.meta.recommendedTextColor || "—" }}
                <span v-if="a.meta.validator && a.meta.validator.attempts > 1">
                  · {{ a.meta.validator.attempts }} попытки
                </span>
              </p>

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
                  :title="isStyleAnchor(a.assetKey) ? 'Перегенерирует и зависимые форматы — они наследуют стиль этой композиции' : undefined"
                  @click="regenerateWithCascade(a.assetKey, a.id)"
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
  position: relative;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--color-segment);
  display: grid;
  place-items: center;
  /* cqw below sizes the mock text relative to the картинке, not the viewport,
     so the preview reads the same on any card width. */
  container-type: size;
}
.asset__frame img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  /* Assets ship with an alpha channel — the checkerboard behind the image is
     what makes the empty areas readable as transparent rather than white. */
  background-color: #fff;
  background-image:
    linear-gradient(45deg, #d4d4d4 25%, transparent 25%),
    linear-gradient(-45deg, #d4d4d4 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #d4d4d4 75%),
    linear-gradient(-45deg, transparent 75%, #d4d4d4 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}
/* Подложки письма (DV-A1): свечение внутри прозрачного ассета читается
   по-разному, и дизайнер должен видеть оба сценария. */
.asset__frame--light img,
.asset__frame--dark img {
  background-image: none;
}
.asset__frame--light img {
  background-color: #f2f2f2;
}
.asset__frame--dark img {
  background-color: #0d0d0d;
}
.backdrop {
  display: inline-flex;
  gap: 2px;
  margin-left: 12px;
}
.backdrop__btn {
  border: 1px solid var(--color-border);
  background: var(--color-white);
  color: var(--color-text);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  font-size: 13px;
  line-height: 1.4;
  cursor: pointer;
}
.backdrop__btn--on {
  background: var(--color-text);
  color: var(--color-white);
}
/* Style-profile (DV-E1) — админский редактор стиля сцены */
.style__toggle {
  margin-left: auto;
}
.style {
  margin: 0 0 12px;
  padding: 10px 12px;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-sm);
}
.style__hint {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--color-text-muted, #777);
}
.style__json {
  width: 100%;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 8px;
  resize: vertical;
}
.style__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.style__msg {
  font-size: 12px;
  color: var(--color-text-muted, #777);
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

.result__sectionrow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.safetoggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--color-grey);
  cursor: pointer;
}
.safetoggle input {
  width: 14px;
  height: 14px;
  accent-color: var(--color-accent);
  cursor: pointer;
}

/* Mock email text inside the safe zone — review only, never baked in (D-E1). */
.safe {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1.5cqw;
  text-align: center;
  border: 1px dashed color-mix(in srgb, currentColor 55%, transparent);
  background: color-mix(in srgb, var(--color-accent) 8%, transparent);
  font-weight: 800;
  line-height: 1.05;
  text-transform: uppercase;
  pointer-events: none;
}
.safe__up {
  font-size: 4cqw;
  letter-spacing: 0.12em;
}
.safe__sum {
  font-size: 10cqw;
}
.safe__spins {
  font-size: 4.4cqw;
}
.safe__cta {
  margin-top: 1cqw;
  padding: 1.6cqw 4cqw;
  border-radius: 999px;
  /* Outlined pill: `color` stays the recommended text colour, so the button
     mock never introduces a colour the валидатор did not check. */
  border: 0.4cqw solid currentColor;
  background: color-mix(in srgb, currentColor 14%, transparent);
  font-size: 3.4cqw;
  letter-spacing: 0.04em;
}
.asset__meta {
  margin: 0;
  font-size: 10.5px;
  color: var(--color-grey);
}
/* Бейдж приёмки ai_reference (DI-R10) */
.asset__qa {
  margin: 0;
  font-size: 10.5px;
  font-weight: 600;
  color: #b45309;
  background: #fef3c7;
  border-radius: var(--radius-sm);
  padding: 5px 8px;
  line-height: 1.35;
}
:global(.dark) .asset__qa {
  background: rgba(180, 83, 9, 0.16);
}
.asset__qa-score {
  display: block;
  margin-top: 2px;
  font-weight: 700;
  opacity: 0.85;
}
.asset__qa-reasons {
  display: block;
  font-weight: 400;
  color: inherit;
  opacity: 0.85;
}
/* Бейдж текстового гейта (TASK no-baked-text). Красный, а не янтарный, как у
   приёмки: приёмка сообщает «возможно, недостаточно хорошо», а этот — про
   конкретный однозначный брак, который менеджер обязан заметить. */
.asset__text-gate {
  margin: 0;
  font-size: 10.5px;
  font-weight: 600;
  color: #b91c1c;
  background: #fee2e2;
  border-radius: var(--radius-sm);
  padding: 5px 8px;
  line-height: 1.35;
}
:global(.dark) .asset__text-gate {
  background: rgba(185, 28, 28, 0.18);
  color: #fca5a5;
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
