<script setup lang="ts">
// Управление вариациями и их референсами (TASK ai-reference, DI-R3/R12).
// Доступно CRM_SUPER / ADMIN / MANAGER — тот же гейт, что весь сервис бандлов
// (бэкенд: /api/crm-admin за requireCrmSuper). Слева — вариации (промпт-
// пресеты), справа — референсы выбранной тройки «вариация × бренд × формат»:
// 5–15 готовых баннеров, из которых пайплайн собирает новую композицию.
//
// TASK multiformat-promo (DI2-1): у email, push и pop-up разная стилистика,
// поэтому после выбора бренда появляются ВКЛАДКИ ФОРМАТОВ — по одной на
// каждый ассет, у которого в /admin включён режим ai_reference.
import { ref, computed, onMounted, watch } from "vue";
import { effectiveRefCount, toneLabel } from "~/utils/refGating";

const api = useApi();
const store = useBundlesStore();

interface Preset {
  id: string;
  title: string;
  text: string;
  order: number;
  isActive: boolean;
  /**
   * Разрешён ли запечённый текст на баннерах (TASK no-baked-text). Настройка
   * общая на все форматы кампании: email-якорь задаёт стиль push/pop-up, и
   * разные режимы у якоря и зависимых форматов конфликтовали бы.
   */
  allowText: boolean;
}
interface RefRow {
  id: string;
  brandName: string;
  assetKey: string;
  imageUrl: string;
  width: number;
  height: number;
  sortOrder: number;
}
interface RefFormat {
  key: string;
  label: string;
  width: number;
  height: number;
  /** Якорь кампании (email): его композиция задаёт стиль остальным (DI2-3). */
  isAnchor: boolean;
}
/** counts: бренд → формат → сколько загружено. */
type RefCounts = Record<string, Record<string, number>>;

const MIN_REFS = 5;
const MAX_REFS = 15;
/** В генерацию уходят первые 14 (лимит nano-banana-2 /edit, DI-R5). */
const GEN_REFS = 14;

// ---- Вариации ----
const presets = ref<Preset[]>([]);
const presetsLoading = ref(false);
const selectedPresetId = ref<string | null>(null);
const presetForm = ref<{
  id: string | null;
  title: string;
  text: string;
  allowText: boolean;
} | null>(null);
const presetBusy = ref(false);
const error = ref("");
/** Показывается после сохранения: настройка не переписывает готовые бандлы. */
const presetNotice = ref("");

async function fetchPresets() {
  presetsLoading.value = true;
  error.value = "";
  try {
    const res = await api<{ presets: Preset[] }>("/api/crm-admin/prompt-presets");
    presets.value = res.presets;
    if (!selectedPresetId.value && res.presets[0]) selectedPresetId.value = res.presets[0].id;
  } catch {
    error.value = "Не удалось загрузить вариации";
  } finally {
    presetsLoading.value = false;
  }
}

function openPresetForm(p: Preset | null) {
  // Новая вариация открывается в строгом режиме — так же, как приезжают все
  // существующие после миграции (TASK no-baked-text).
  presetForm.value = p
    ? { id: p.id, title: p.title, text: p.text, allowText: p.allowText }
    : { id: null, title: "", text: "", allowText: false };
  presetNotice.value = "";
}

async function savePreset() {
  const form = presetForm.value;
  if (!form || !form.title.trim() || !form.text.trim()) return;
  presetBusy.value = true;
  error.value = "";
  // Режим текста меняется до сброса формы — сообщение показываем только когда
  // менеджер реально его переключил.
  const textModeChanged = form.id
    ? presets.value.find((p) => p.id === form.id)?.allowText !== form.allowText
    : false;
  try {
    const body = { title: form.title.trim(), text: form.text.trim(), allowText: form.allowText };
    if (form.id) {
      await api(`/api/crm-admin/prompt-presets/${form.id}`, { method: "PATCH", body });
    } else {
      const res = await api<{ preset: Preset }>("/api/crm-admin/prompt-presets", {
        method: "POST",
        body,
      });
      selectedPresetId.value = res.preset.id;
    }
    presetForm.value = null;
    presetNotice.value = textModeChanged
      ? "Режим текста изменён — настройка применится к новым генерациям, готовые бандлы не меняются."
      : "";
    await fetchPresets();
  } catch {
    error.value = "Не удалось сохранить вариацию";
  } finally {
    presetBusy.value = false;
  }
}

async function deletePreset(p: Preset) {
  // Каскад: удаление вариации сносит и её референсы (onDelete: Cascade).
  if (!window.confirm(`Удалить вариацию «${p.title}» и все её референсы?`)) return;
  presetBusy.value = true;
  try {
    await api(`/api/crm-admin/prompt-presets/${p.id}`, { method: "DELETE" });
    if (selectedPresetId.value === p.id) selectedPresetId.value = null;
    await fetchPresets();
  } catch {
    error.value = "Не удалось удалить вариацию";
  } finally {
    presetBusy.value = false;
  }
}

// ---- Референсы «вариация × бренд(тон) × формат» ----
const selectedBrand = ref<string | null>(null);
// Тон-вариант (DI2-10): персонажа задают референсы, поэтому у (Men) и (Women)
// должны быть РАЗНЫЕ пулы. `selectedTone` — это и есть имя, под которым
// хранятся строки: базовое («Betnella» = общий пул) либо полное имя варианта.
const selectedTone = ref<string | null>(null);
const formats = ref<RefFormat[]>([]);
const selectedFormat = ref<string | null>(null);
const refs = ref<RefRow[]>([]);
const counts = ref<RefCounts>({});
const refsLoading = ref(false);
const uploadBusy = ref(false);
const uploadReport = ref<string[]>([]);

const tripleReady = computed(() =>
  Boolean(selectedPresetId.value && selectedTone.value && selectedFormat.value),
);

/**
 * Тон-варианты выбранного бренда: «Общие» (базовое имя, работает для обоих
 * полов) + по одному пункту на каждый существующий вариант. У брендов без
 * разделения список схлопывается в один пункт и переключатель не рисуется.
 */
const toneOptions = computed<Array<{ key: string; label: string; own: boolean }>>(() => {
  const group = store.brands.find((b) => b.key === selectedBrand.value);
  if (!group) return [];
  const genderVariants = group.variants.filter((v) => v.name !== group.key);
  if (genderVariants.length === 0) return [{ key: group.key, label: "Общие", own: false }];
  return [
    { key: group.key, label: "Общие", own: false },
    ...genderVariants.map((v) => ({
      key: v.name,
      label: toneLabel(v.displayName, group.key) || v.displayName,
      own: true,
    })),
  ];
});
const showToneSwitch = computed(() => toneOptions.value.length > 1);

/** Сколько референсов у выбранного тона в конкретном формате. */
function countOf(tone: string | null, format: string | null): number {
  if (!tone || !format) return 0;
  return counts.value[tone]?.[format] ?? 0;
}

/**
 * Фактический пул тона (зеркало серверного правила): свои референсы, а если их
 * нет — общие бренда. По нему и рисуется счётчик на вкладке формата.
 */
function effectiveCount(format: string): number {
  const base = selectedBrand.value;
  const tone = selectedTone.value;
  if (!base || !tone) return 0;
  return effectiveRefCount(counts.value, base, tone, format);
}

/** true — пул тона пустой и в дело идут общие референсы бренда. */
function inheritsBase(format: string): boolean {
  const base = selectedBrand.value;
  const tone = selectedTone.value;
  return Boolean(base && tone && tone !== base && countOf(tone, format) === 0);
}

/** Сумма по всем форматам и тонам — подпись бренда в селекторе. */
function brandTotal(brand: string): number {
  const group = store.brands.find((b) => b.key === brand);
  const names = [brand, ...(group?.variants.map((v) => v.name) ?? [])];
  return [...new Set(names)].reduce(
    (sum, name) => sum + Object.values(counts.value[name] ?? {}).reduce((s, n) => s + n, 0),
    0,
  );
}

async function fetchFormats() {
  try {
    const res = await api<{ formats: RefFormat[] }>("/api/crm-admin/ref-formats");
    formats.value = res.formats;
    // Дефолт — якорь кампании (email): с него начинается любая раскладка.
    if (!selectedFormat.value || !res.formats.some((f) => f.key === selectedFormat.value)) {
      selectedFormat.value = (res.formats.find((f) => f.isAnchor) ?? res.formats[0])?.key ?? null;
    }
  } catch {
    error.value = "Не удалось загрузить список форматов";
  }
}

async function fetchRefs() {
  if (!tripleReady.value) {
    refs.value = [];
    return;
  }
  refsLoading.value = true;
  try {
    const res = await api<{ refs: RefRow[]; counts: RefCounts }>("/api/crm-admin/bundle-refs", {
      query: {
        presetId: selectedPresetId.value,
        brandName: selectedTone.value,
        assetKey: selectedFormat.value,
      },
    });
    refs.value = res.refs;
    counts.value = res.counts;
  } catch {
    error.value = "Не удалось загрузить референсы";
  } finally {
    refsLoading.value = false;
  }
}

// Смена бренда сбрасывает тон на «Общие» — иначе с бренда с разделением
// можно унести чужой ключ варианта на бренд, где его нет.
// Сходство персонажа с референсами (правка 2026-08-13). Настройка бренда
// целиком: пишется во все его тон-варианты, поэтому чекбокс один на бренд.
const fidelityBusy = ref(false);
const fidelityMsg = ref("");

const exactCharacter = computed(
  () => store.brands.find((b) => b.key === selectedBrand.value)?.exactCharacter ?? false,
);

async function toggleExactCharacter(e: Event) {
  const brandKey = selectedBrand.value;
  if (!brandKey || fidelityBusy.value) return;
  const exact = (e.target as HTMLInputElement).checked;
  fidelityBusy.value = true;
  fidelityMsg.value = "";
  try {
    await api("/api/crm-admin/brand-fidelity", { method: "PATCH", body: { brandKey, exact } });
    // Локально — чтобы галка не «отскакивала» до следующей загрузки справочника.
    const group = store.brands.find((b) => b.key === brandKey);
    if (group) group.exactCharacter = exact;
    fidelityMsg.value = exact ? "Персонаж: один в один ✓" : "Персонаж: вариативный ✓";
  } catch {
    fidelityMsg.value = "Не удалось сохранить";
  } finally {
    fidelityBusy.value = false;
  }
}

watch(selectedBrand, (brand) => {
  fidelityMsg.value = "";
  selectedTone.value = brand;
});
watch([selectedPresetId, selectedTone, selectedFormat], () => {
  uploadReport.value = [];
  void fetchRefs();
});

async function onFilesPicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  if (!files.length || !tripleReady.value) return;
  uploadBusy.value = true;
  uploadReport.value = [];
  error.value = "";
  try {
    const form = new FormData();
    form.append("presetId", selectedPresetId.value!);
    form.append("brandName", selectedTone.value!);
    form.append("assetKey", selectedFormat.value!);
    for (const f of files) form.append("files", f);
    const res = await api<{ results: Array<{ name: string; ok: boolean; reason?: string }> }>(
      "/api/crm-admin/bundle-refs",
      { method: "POST", body: form },
    );
    uploadReport.value = res.results
      .filter((r) => !r.ok)
      .map((r) => `${r.name}: ${r.reason ?? "ошибка"}`);
    await fetchRefs();
  } catch (err) {
    const details = (err as { data?: { details?: string } })?.data?.details;
    error.value = details ? `Загрузка не удалась: ${details}` : "Загрузка не удалась";
  } finally {
    uploadBusy.value = false;
  }
}

async function deleteRef(r: RefRow) {
  try {
    await api(`/api/crm-admin/bundle-refs/${r.id}`, { method: "DELETE" });
    await fetchRefs();
  } catch {
    error.value = "Не удалось удалить референс";
  }
}

/** Порядок = приоритет: первые 14 уходят в модель (DI-R5). Кнопки ←/→. */
async function moveRef(index: number, delta: -1 | 1) {
  const next = [...refs.value];
  const target = index + delta;
  if (target < 0 || target >= next.length) return;
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item!);
  refs.value = next; // оптимистично — сервер вернёт каноничный порядок
  try {
    const res = await api<{ refs: RefRow[] }>("/api/crm-admin/bundle-refs/reorder", {
      method: "POST",
      body: {
        presetId: selectedPresetId.value,
        brandName: selectedTone.value,
        assetKey: selectedFormat.value,
        ids: next.map((r) => r.id),
      },
    });
    refs.value = res.refs;
  } catch {
    error.value = "Не удалось изменить порядок";
    await fetchRefs();
  }
}

const countLabel = computed(() => `${refs.value.length}/${MAX_REFS}`);
const countState = computed(() =>
  refs.value.length >= MIN_REFS ? "ok" : refs.value.length > 0 ? "warn" : "empty",
);

/** Пропорции превью текущего формата — миниатюры не врут о кадре. */
const thumbRatio = computed(() => {
  const f = formats.value.find((x) => x.key === selectedFormat.value);
  return f ? `${f.width} / ${f.height}` : "2 / 1";
});

const currentFormat = computed(() => formats.value.find((f) => f.key === selectedFormat.value));

onMounted(() => {
  void fetchPresets();
  void fetchFormats();
  if (!store.metaReady) void store.fetchMeta();
});
</script>

<template>
  <section class="refs">
    <header class="refs__head">
      <h2 class="refs__title">Вариации и референсы</h2>
      <p class="refs__hint">
        Для генерации нужно 5–15 готовых баннеров на каждый формат пары «вариация × бренд».
        Первые {{ GEN_REFS }} по порядку уходят в модель — порядок можно менять стрелками.
      </p>
    </header>

    <p v-if="error" class="refs__error">{{ error }}</p>

    <div class="refs__grid">
      <!-- Вариации -->
      <aside class="panel">
        <div class="panel__head">
          <b>Вариации</b>
          <button class="btn btn--sm" type="button" @click="openPresetForm(null)">+ Новая</button>
        </div>
        <p v-if="presetsLoading" class="panel__note">Loading…</p>
        <ul v-else class="plist">
          <li
            v-for="p in presets"
            :key="p.id"
            class="plist__item"
            :class="{ 'plist__item--on': selectedPresetId === p.id, 'plist__item--off': !p.isActive }"
          >
            <button class="plist__main" type="button" @click="selectedPresetId = p.id">
              <b>
                {{ p.title }}
                <!-- Бейдж только у ИСКЛЮЧЕНИЯ: строгий режим — норма, и его
                     отсутствие не должно занимать место в списке. -->
                <span v-if="p.allowText" class="plist__badge" title="На баннерах этой вариации разрешён текст">Aa</span>
              </b>
              <small>{{ p.text }}</small>
            </button>
            <span class="plist__tools">
              <button class="icon" type="button" title="Редактировать" @click="openPresetForm(p)">✎</button>
              <button class="icon icon--danger" type="button" title="Удалить" :disabled="presetBusy" @click="deletePreset(p)">🗑</button>
            </span>
          </li>
          <li v-if="!presets.length" class="panel__note">Вариаций пока нет — создайте первую.</li>
        </ul>

        <p v-if="presetNotice" class="pform__notice">{{ presetNotice }}</p>

        <div v-if="presetForm" class="pform">
          <b>{{ presetForm.id ? "Редактировать вариацию" : "Новая вариация" }}</b>
          <input v-model="presetForm.title" type="text" maxlength="120" placeholder="Название (например, VIP Exclusive)" />
          <textarea v-model="presetForm.text" rows="4" maxlength="1500" placeholder="Текст промпта — смысл композиции" />
          <label class="pform__check">
            <input v-model="presetForm.allowText" type="checkbox" />
            <span>
              Разрешить текст на баннере
              <small>
                По умолчанию выключено: нейросеть не рисует надписи, буквы и цифры.
                Ранги и масти на игральных картах разрешены всегда.
              </small>
            </span>
          </label>
          <div class="pform__actions">
            <button class="btn btn--sm btn--primary" type="button" :disabled="presetBusy || !presetForm.title.trim() || !presetForm.text.trim()" @click="savePreset">Сохранить</button>
            <button class="btn btn--sm" type="button" @click="presetForm = null">Отмена</button>
          </div>
        </div>
      </aside>

      <!-- Референсы выбранной пары -->
      <div class="panel">
        <div class="panel__head panel__head--wrap">
          <b>Референсы</b>
          <select v-model="selectedBrand" class="brandsel">
            <option :value="null" disabled>Выберите бренд</option>
            <option v-for="b in store.brands" :key="b.key" :value="b.key">
              {{ b.displayName }}{{ brandTotal(b.key) ? ` — ${brandTotal(b.key)}` : "" }}
            </option>
          </select>
          <label
            v-if="selectedBrand"
            class="fidelity"
            title="Один в один — маскот бренда копируется с референсов без изменений (фиксированный персонаж). Снято — персонаж узнаваем по стилю и дизайну, но черты, поза и детали свои. Настройка действует на бренд целиком и на все три формата."
          >
            <input
              type="checkbox"
              :checked="exactCharacter"
              :disabled="fidelityBusy"
              @change="toggleExactCharacter"
            />
            Персонаж один в один
          </label>
          <span v-if="fidelityMsg" class="fidelity__msg">{{ fidelityMsg }}</span>
          <span v-if="tripleReady" class="count" :class="`count--${countState}`">{{ countLabel }}</span>
          <label v-if="tripleReady" class="btn btn--sm btn--primary upload" :class="{ 'upload--busy': uploadBusy }">
            <input type="file" accept="image/png,image/jpeg,image/webp" multiple :disabled="uploadBusy || refs.length >= MAX_REFS" @change="onFilesPicked" />
            {{ uploadBusy ? "Загрузка…" : "⬆ Загрузить" }}
          </label>
        </div>

        <p v-if="!selectedPresetId" class="panel__note">Выберите вариацию слева.</p>
        <p v-else-if="!selectedBrand" class="panel__note">Выберите бренд, чтобы увидеть его референсы.</p>
        <p v-else-if="!formats.length" class="panel__warn">
          Ни для одного ассета не включён режим «AI по референсам» — включите его в /admin,
          чтобы загружать референсы.
        </p>
        <template v-else>
          <!-- Тон-варианты (DI2-10): персонажа задают референсы, поэтому у
               (Men) и (Women) могут быть свои пулы. «Общие» — один пул на оба. -->
          <div v-if="showToneSwitch" class="tone">
            <button
              v-for="t in toneOptions"
              :key="t.key"
              class="tone__item"
              :class="{ 'tone__item--on': selectedTone === t.key }"
              type="button"
              :title="t.own ? 'Свой пул этого тона; пустой — берутся общие' : 'Общий пул: работает для обоих тонов'"
              @click="selectedTone = t.key"
            >
              {{ t.label }}
            </button>
          </div>
          <!-- Вкладки форматов (DI2-1): у email, push и pop-up свои пулы. -->
          <nav class="tabs">
            <button
              v-for="f in formats"
              :key="f.key"
              class="tabs__item"
              :class="{
                'tabs__item--on': selectedFormat === f.key,
                'tabs__item--low': effectiveCount(f.key) < MIN_REFS,
              }"
              type="button"
              :title="f.isAnchor ? 'Якорь кампании: задаёт стиль остальным форматам' : `${f.width}×${f.height}`"
              @click="selectedFormat = f.key"
            >
              {{ f.label }}<span v-if="f.isAnchor" class="tabs__anchor" title="Якорь кампании">★</span>
              <b :title="inheritsBase(f.key) ? 'Свой пул пуст — используются общие референсы бренда' : undefined">
                {{ effectiveCount(f.key) }}<template v-if="inheritsBase(f.key)">*</template>
              </b>
            </button>
          </nav>

          <p
            v-if="selectedFormat && inheritsBase(selectedFormat)"
            class="panel__note panel__note--hint"
          >
            Свой пул этого тона пуст — в генерацию пойдут общие референсы бренда
            ({{ effectiveCount(selectedFormat) }} шт.), и пол героя будет зависеть от них.
            Загрузите сюда 5–15 баннеров, чтобы задать его явно.
          </p>
          <p v-else-if="refs.length < MIN_REFS" class="panel__warn">
            Для генерации нужно минимум {{ MIN_REFS }} референсов формата
            «{{ currentFormat?.label ?? selectedFormat }}» — сейчас {{ refs.length }}.
            Бренд без полного набора по всем форматам и тонам в мастер не попадёт.
          </p>
          <ul v-if="uploadReport.length" class="panel__report">
            <li v-for="(r, i) in uploadReport" :key="i">✗ {{ r }}</li>
          </ul>
          <p v-if="refsLoading" class="panel__note">Loading…</p>
          <div v-else class="thumbs">
            <figure v-for="(r, i) in refs" :key="r.id" class="thumb" :class="{ 'thumb--cut': i >= GEN_REFS }">
              <img :src="r.imageUrl" :alt="`ref ${i + 1}`" loading="lazy" :style="{ aspectRatio: thumbRatio }" />
              <figcaption class="thumb__bar">
                <span class="thumb__num" :title="i >= GEN_REFS ? `Не попадает в генерацию (лимит ${GEN_REFS})` : 'Уходит в генерацию'">#{{ i + 1 }}</span>
                <span class="thumb__tools">
                  <button class="icon" type="button" title="Раньше" :disabled="i === 0" @click="moveRef(i, -1)">←</button>
                  <button class="icon" type="button" title="Позже" :disabled="i === refs.length - 1" @click="moveRef(i, 1)">→</button>
                  <button class="icon icon--danger" type="button" title="Удалить" @click="deleteRef(r)">🗑</button>
                </span>
              </figcaption>
            </figure>
            <p v-if="!refs.length" class="panel__note">
              Референсов нет. Загрузите 5–15 готовых баннеров формата
              «{{ currentFormat?.label ?? selectedFormat }}» для этого бренда
              (PNG/JPEG/WebP до 10 МБ).
            </p>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.refs {
  display: flex;
  flex-direction: column;
  gap: 14px;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  padding: 22px;
  min-height: 0;
  overflow-y: auto;
}
.refs__head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.refs__title {
  margin: 0;
  font-size: 16px;
  color: var(--color-text);
}
.refs__hint {
  margin: 0;
  font-size: 12px;
  color: var(--color-grey);
}
.refs__error {
  margin: 0;
  font-size: 12.5px;
  color: var(--color-stop-hover);
}
.refs__grid {
  display: grid;
  grid-template-columns: minmax(260px, 340px) 1fr;
  gap: 16px;
  align-items: start;
}
@media (max-width: 980px) {
  .refs__grid {
    grid-template-columns: 1fr;
  }
}

.panel {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.panel__head {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: space-between;
  font-size: 13px;
  color: var(--color-text);
}
.panel__head--wrap {
  justify-content: flex-start;
  flex-wrap: wrap;
}
.panel__note {
  margin: 0;
  font-size: 12px;
  color: var(--color-grey);
}
.panel__warn {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: #b45309;
  background: #fef3c7;
  border-radius: var(--radius-sm);
  padding: 6px 9px;
}
:global(.dark) .panel__warn {
  background: rgba(180, 83, 9, 0.16);
}
.panel__report {
  margin: 0;
  padding-left: 16px;
  font-size: 11.5px;
  color: var(--color-stop-hover);
}

.btn {
  border: 1px solid var(--color-border);
  background: none;
  color: var(--color-text);
  border-radius: var(--radius-sm);
  padding: 7px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.btn:hover:not(:disabled) {
  border-color: var(--color-accent);
}
.btn--sm {
  padding: 5px 10px;
  font-size: 11.5px;
}
.btn--primary {
  background: var(--gradient-active, var(--color-accent));
  border: none;
  color: #fff;
}
.icon {
  border: none;
  background: none;
  cursor: pointer;
  font-size: 12px;
  color: var(--color-grey);
  padding: 2px 4px;
}
.icon:hover:not(:disabled) {
  color: var(--color-text);
}
.icon:disabled {
  opacity: 0.35;
  cursor: default;
}
.icon--danger:hover:not(:disabled) {
  color: var(--color-stop-hover);
}

.plist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 420px;
  overflow-y: auto;
}
.plist__item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
}
.plist__item--on {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 1px var(--color-accent);
}
.plist__item--off {
  opacity: 0.55;
}
.plist__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: none;
  background: none;
  text-align: left;
  cursor: pointer;
  padding: 0;
}
.plist__main b {
  font-size: 12.5px;
  color: var(--color-text);
}
.plist__main small {
  font-size: 11px;
  color: var(--color-grey);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.plist__tools {
  display: flex;
  gap: 2px;
  flex: 0 0 auto;
}
/* Бейдж режима текста (TASK no-baked-text): рисуется только у вариаций,
   где текст РАЗРЕШЁН, — строгий режим норма и метки не требует. */
.plist__badge {
  display: inline-block;
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  line-height: 15px;
  vertical-align: middle;
  color: #b45309;
  background: #fef3c7;
}

.pform {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-sm);
  padding: 10px;
  font-size: 12.5px;
  color: var(--color-text);
}
.pform__check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  cursor: pointer;
}
.pform__check input {
  margin-top: 2px;
  width: auto;
  flex: 0 0 auto;
}
.pform__check small {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.35;
  color: var(--color-grey);
}
.pform__notice {
  margin: 0;
  font-size: 11.5px;
  color: #b45309;
  background: #fef3c7;
  border-radius: var(--radius-sm);
  padding: 6px 9px;
}
.pform input,
.pform textarea {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: none;
  color: var(--color-text);
  font-size: 12.5px;
  font-family: inherit;
  padding: 8px 10px;
  outline: none;
}
.pform input:focus,
.pform textarea:focus {
  border-color: var(--color-accent);
}
.pform__actions {
  display: flex;
  gap: 8px;
}

.fidelity {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
.fidelity__msg {
  font-size: 12px;
  opacity: 0.7;
}
.brandsel {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-white);
  color: var(--color-text);
  font-size: 12.5px;
  padding: 6px 9px;
  outline: none;
  max-width: 240px;
}
.count {
  font-size: 11px;
  font-weight: 700;
  border-radius: var(--radius-pill);
  padding: 3px 9px;
  background: var(--color-segment);
}
.count--ok {
  color: #16a34a;
}
.count--warn {
  color: #b45309;
}
.count--empty {
  color: var(--color-grey);
}
.upload {
  margin-left: auto;
  position: relative;
  overflow: hidden;
}
.upload input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.upload--busy {
  opacity: 0.6;
}

.tone {
  display: inline-flex;
  gap: 2px;
  background: var(--color-segment);
  border-radius: var(--radius-pill);
  padding: 2px;
  align-self: flex-start;
}
.tone__item {
  border: none;
  background: none;
  color: var(--color-grey);
  border-radius: var(--radius-pill);
  padding: 4px 12px;
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
}
.tone__item--on {
  background: var(--color-white);
  color: var(--color-text);
}
.panel__note--hint {
  border-left: 2px solid var(--color-accent);
  padding-left: 8px;
}

.tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.tabs__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--color-border);
  background: none;
  color: var(--color-grey);
  border-radius: var(--radius-pill);
  padding: 5px 12px;
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
}
.tabs__item b {
  font-size: 10.5px;
  border-radius: var(--radius-pill);
  background: var(--color-segment);
  padding: 1px 7px;
}
.tabs__item--on {
  border-color: var(--color-accent);
  color: var(--color-text);
  box-shadow: 0 0 0 1px var(--color-accent);
}
.tabs__item--low b {
  color: #b45309;
  background: #fef3c7;
}
:global(.dark) .tabs__item--low b {
  background: rgba(180, 83, 9, 0.16);
}
.tabs__anchor {
  font-size: 10px;
  color: var(--color-accent);
}

.thumbs {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 10px;
}
.thumb {
  margin: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.thumb--cut {
  opacity: 0.55;
}
.thumb img {
  width: 100%;
  /* Пропорции задаёт выбранный формат (inline style) — 2:1 как запасной. */
  aspect-ratio: 2 / 1;
  object-fit: cover;
  display: block;
  background: var(--color-segment);
}
.thumb__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px;
}
.thumb__num {
  font-size: 10.5px;
  font-weight: 700;
  color: var(--color-grey);
}
.thumb__tools {
  display: flex;
  gap: 2px;
}
</style>
