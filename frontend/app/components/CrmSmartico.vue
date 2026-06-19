<script setup lang="ts">

import { ref, computed, onUnmounted } from "vue";

type TypeKey = "email" | "push" | "pop-up" | "pop-up_1" | "pop-up_2";

interface AnalyzedBrand {
  raw: string;
  canonical: string;
  matched: boolean;
  suspicious: boolean;
  isAllBrands: boolean;
  isKorea: boolean;
  koreaVariant: "standard" | "realistic" | null;
  types: Partial<Record<TypeKey, { default: boolean; KO: boolean }>>;
  imageCount: number;
}
interface AnalyzeResponse {
  token: string;
  zipName: string;
  availableTypes: TypeKey[];
  brands: AnalyzedBrand[];
  suspiciousBrands: string[];
  totalImages: number;
}
interface OutputBlock {
  title: string;
  code: string;
  kind: "function" | "label";
}
interface JobResult {
  outputs: OutputBlock[];
  stats: { total: number; uploaded: number; reused: number; failed: number; failedItems: string[] };
}
interface JobResponse {
  status: "queued" | "active" | "completed" | "failed";
  progress: number;
  result?: JobResult;
  error?: string;
}

const ERROR_TEXT: Record<string, string> = {
  file_too_large: "Файл больше 100 МБ — уменьшите архив.",
  invalid_zip: "Не удалось прочитать ZIP-архив.",
  no_brands_detected: "В архиве не найдено брендов с картинками CRM.",
  no_zip_file: "Файл не получен — попробуйте ещё раз.",
  upload_failed: "Ошибка загрузки. Попробуйте ещё раз.",
  upload_expired: "Загрузка устарела — загрузите ZIP заново.",
  cloudinary_not_configured: "Cloudinary не настроен на сервере.",
  queue_unavailable: "Очередь недоступна — попробуйте позже.",
  network_error: "Сеть недоступна. Проверьте подключение.",
};

const config = useRuntimeConfig();
const api = useApi();
const { copiedKey, markCopied } = useCopied(1800);

type Phase = "idle" | "analyzing" | "configure" | "generating" | "done" | "error";
const phase = ref<Phase>("idle");
const errorMsg = ref("");
const dragOver = ref(false);

const fileName = ref("");
const fileSizeMb = ref("");
const uploadPct = ref(0);

const analysis = ref<AnalyzeResponse | null>(null);
const selectedTypes = ref<TypeKey[]>([]);

const genPct = ref(0);
const genStatus = ref<JobResponse["status"]>("queued");
const result = ref<JobResult | null>(null);

let pollTimer: ReturnType<typeof setTimeout> | undefined;
const fileInput = ref<HTMLInputElement | null>(null);

const suspiciousBrands = computed(() =>
  (analysis.value?.brands ?? []).filter((b) => b.suspicious),
);
const canGenerate = computed(
  () =>
    (phase.value === "configure" || phase.value === "done") &&
    selectedTypes.value.length > 0,
);

interface UiType {
  id: string;
  label: string;
  icon: string;
  type: TypeKey; // backend TypeKey this checkbox toggles
  present: boolean; // found in the uploaded archive
}
const availableSet = computed(() => new Set(analysis.value?.availableTypes ?? []));
const popupBase = computed<TypeKey>(() =>
  availableSet.value.has("pop-up_1") ? "pop-up_1" : "pop-up",
);
const uiTypes = computed<UiType[]>(() => {
  const a = availableSet.value;
  const popupPresent = a.has("pop-up_1") || a.has("pop-up");
  const list: UiType[] = [
    { id: "email", label: "Email", icon: "📧", type: "email", present: a.has("email") },
    { id: "pop-up", label: "Pop-up", icon: "💬", type: popupBase.value, present: popupPresent },
    { id: "push", label: "Push", icon: "🔔", type: "push", present: a.has("push") },
  ];
  if (a.has("pop-up_2")) {
    list.push({ id: "pop-up_2", label: "Pop-up 2", icon: "💬", type: "pop-up_2", present: true });
  }
  return list;
});

function errText(code: string | undefined): string {
  return (code && ERROR_TEXT[code]) || ERROR_TEXT.upload_failed!;
}

function reset() {
  if (pollTimer) clearTimeout(pollTimer);
  phase.value = "idle";
  errorMsg.value = "";
  fileName.value = "";
  fileSizeMb.value = "";
  uploadPct.value = 0;
  analysis.value = null;
  selectedTypes.value = [];
  genPct.value = 0;
  result.value = null;
  if (fileInput.value) fileInput.value.value = "";
}

// ---- Step 1: upload + analyze (XHR for upload progress on big files) ----
function uploadAndAnalyze(file: File): Promise<AnalyzeResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${config.public.apiBase}/api/smartico/analyze`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) uploadPct.value = Math.round((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as AnalyzeResponse);
        } catch {
          reject(new Error("invalid_zip"));
        }
      } else {
        let code = "upload_failed";
        try {
          code = (JSON.parse(xhr.responseText) as { error?: string }).error ?? code;
        } catch {
          /* keep default */
        }
        reject(new Error(code));
      }
    };
    xhr.onerror = () => reject(new Error("network_error"));
    const form = new FormData();
    form.append("zip", file);
    xhr.send(form);
  });
}

async function handleFile(file: File) {
  if (!file.name.toLowerCase().endsWith(".zip")) {
    phase.value = "error";
    errorMsg.value = "Нужен файл .zip";
    return;
  }
  reset();
  fileName.value = file.name;
  fileSizeMb.value = (file.size / 1024 / 1024).toFixed(2) + " MB";
  phase.value = "analyzing";
  uploadPct.value = 0;
  try {
    const res = await uploadAndAnalyze(file);
    analysis.value = res;
    // Pre-select every checkbox the archive actually has (mapped to backend types).
    selectedTypes.value = uiTypes.value.filter((u) => u.present).map((u) => u.type);
    phase.value = "configure";
  } catch (e) {
    phase.value = "error";
    errorMsg.value = errText((e as Error).message);
  }
}

function onInputChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) void handleFile(file);
}
function onDrop(e: DragEvent) {
  dragOver.value = false;
  const file = e.dataTransfer?.files?.[0];
  if (file) void handleFile(file);
}

function toggleType(t: TypeKey) {
  const i = selectedTypes.value.indexOf(t);
  if (i >= 0) selectedTypes.value.splice(i, 1);
  else selectedTypes.value.push(t);
}

// ---- Step 2: generate + poll ----
async function generate() {
  if (!analysis.value || selectedTypes.value.length === 0) return;
  phase.value = "generating";
  genPct.value = 0;
  genStatus.value = "queued";
  result.value = null;
  try {
    const { jobId } = await api<{ jobId: string }>("/api/smartico/generate", {
      method: "POST",
      body: {
        token: analysis.value.token,
        zipName: analysis.value.zipName,
        selectedTypes: selectedTypes.value,
      },
    });
    pollJob(jobId);
  } catch (e: unknown) {
    phase.value = "error";
    errorMsg.value = errText((e as { data?: { error?: string } })?.data?.error);
  }
}

function pollJob(jobId: string) {
  const tick = async () => {
    try {
      const res = await api<JobResponse>(`/api/smartico/jobs/${jobId}`);
      genStatus.value = res.status;
      genPct.value = res.progress ?? 0;
      if (res.status === "completed" && res.result) {
        result.value = res.result;
        phase.value = "done";
        return;
      }
      if (res.status === "failed") {
        phase.value = "error";
        errorMsg.value = "Генерация не удалась. Попробуйте ещё раз.";
        return;
      }
      pollTimer = setTimeout(tick, 1200);
    } catch {
      pollTimer = setTimeout(tick, 2000); // transient — keep polling
    }
  };
  void tick();
}

async function copyCode(idx: number, code: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(code);
      markCopied(String(idx));
      return;
    } catch {
      /* fall back */
    }
  }
  const ta = document.createElement("textarea");
  ta.value = code;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand("copy");
    markCopied(String(idx));
  } catch {
    /* ignore */
  } finally {
    document.body.removeChild(ta);
  }
}

onUnmounted(() => {
  if (pollTimer) clearTimeout(pollTimer);
});
</script>

<template>
  <div class="smartico">
    <!-- LEFT: upload + configure + generate -->
    <div class="smartico__left">
    <!-- Step 1: upload -->
    <div
      v-if="phase === 'idle' || phase === 'analyzing' || phase === 'error'"
      class="drop"
      :class="{ 'drop--over': dragOver, 'drop--busy': phase === 'analyzing' }"
      role="button"
      tabindex="0"
      @click="fileInput?.click()"
      @keydown.enter="fileInput?.click()"
      @dragover.prevent="dragOver = true"
      @dragleave.prevent="dragOver = false"
      @drop.prevent="onDrop"
    >
      <div class="drop__icon">{{ phase === "analyzing" ? "⏳" : "📦" }}</div>
      <div class="drop__title">
        {{ phase === "analyzing" ? "Загрузка и анализ…" : "Перетащите ZIP или нажмите, чтобы выбрать" }}
      </div>
      <div class="drop__hint">
        Структура: <code>DES-XXXXX/Бренд/CRM/{email, pop-up_1, pop-up_2, push}</code>.
        <code>All brands</code> → сквозная функция, <code>Korea</code> /
        <code>Korea realistic</code> → отдельные KO-функции. До 100 МБ.
      </div>
      <input ref="fileInput" type="file" accept=".zip" hidden @change="onInputChange" />

      <div v-if="phase === 'analyzing'" class="bar">
        <div class="bar__fill" :style="{ width: uploadPct + '%' }" />
      </div>
      <div v-if="phase === 'analyzing'" class="bar__text">{{ uploadPct }}%</div>
    </div>

    <p v-if="phase === 'error'" class="alert alert--error">{{ errorMsg }}</p>

    <!-- Step 2: configure -->
    <div
      v-if="analysis && (phase === 'configure' || phase === 'generating' || phase === 'done')"
      class="panel"
    >
      <div class="filemeta">
        <span class="filemeta__name">✅ {{ fileName }}</span>
        <span class="filemeta__sub">{{ fileSizeMb }} · {{ analysis.brands.length }} брендов · {{ analysis.totalImages }} картинок</span>
        <button class="btn btn--ghost" @click="reset">Другой файл</button>
      </div>

      <p v-if="suspiciousBrands.length" class="alert alert--warn">
        ⚠️ Перепроверьте имена — не найдены в списке Smartico-брендов:
        <b>{{ suspiciousBrands.map((b) => b.raw).join(", ") }}</b>.
        Они всё равно попадут в функцию.
      </p>

      <div class="field">
        <div class="field__label">Типы для генерации</div>
        <div class="types">
          <label
            v-for="u in uiTypes"
            :key="u.id"
            class="type"
            :class="{ 'type--on': u.present && selectedTypes.includes(u.type), 'type--off': !u.present }"
            :title="u.present ? '' : 'Не найдено в архиве'"
          >
            <input
              type="checkbox"
              :checked="selectedTypes.includes(u.type)"
              :disabled="!u.present"
              @change="toggleType(u.type)"
            />
            <span class="type__icon">{{ u.icon }}</span>
            {{ u.label }}
          </label>
        </div>
      </div>

      <details class="brands">
        <summary>Найденные бренды ({{ analysis.brands.length }})</summary>
        <ul class="brands__list">
          <li v-for="b in analysis.brands" :key="b.raw" :class="{ 'brands__row--warn': b.suspicious }">
            <span class="brands__name">
              {{ b.raw }}
              <span v-if="b.isAllBrands" class="tag">Сквозной</span>
              <span v-else-if="b.isKorea" class="tag tag--ko">KO</span>
              <span v-else-if="b.suspicious" class="tag tag--warn">?</span>
              <span v-else-if="b.canonical !== b.raw" class="brands__canon">→ {{ b.canonical }}</span>
            </span>
            <span class="brands__types">{{ Object.keys(b.types).join(", ") }}</span>
          </li>
        </ul>
      </details>

      <button class="btn btn--primary" :disabled="!canGenerate" @click="generate">
        {{ phase === "generating" ? "Генерация…" : `Сгенерировать (${selectedTypes.length})` }}
      </button>
    </div>
    </div>
    <!-- /LEFT -->

    <!-- RIGHT: generated functions, top-to-bottom -->
    <div class="smartico__right" :class="{ 'smartico__right--results': phase === 'done' }">
    <!-- generating -->
    <div v-if="phase === 'generating'" class="panel panel--center">
      <div class="spinner" />
      <div class="gen__status">
        {{ genStatus === "queued" ? "В очереди…" : "Загрузка в Cloudinary и генерация…" }}
      </div>
      <div class="bar"><div class="bar__fill" :style="{ width: genPct + '%' }" /></div>
      <div class="bar__text">{{ genPct }}%</div>
    </div>

    <!-- done -->
    <div v-else-if="phase === 'done' && result" class="panel">
      <div class="filemeta">
        <span class="filemeta__name">Готово — {{ result.outputs.length }} блоков</span>
        <span class="filemeta__sub">
          ↑ {{ result.stats.uploaded }} загружено · ♻ {{ result.stats.reused }} переиспользовано
          <template v-if="result.stats.failed"> · ✗ {{ result.stats.failed }} ошибок</template>
        </span>
        <button class="btn btn--ghost" @click="reset">Новый ZIP</button>
      </div>

      <p v-if="result.stats.failed" class="alert alert--warn">
        Не загрузились: {{ result.stats.failedItems.join(", ") }}
      </p>

      <p v-if="!result.outputs.length" class="alert alert--warn">
        Для выбранных типов нечего сгенерировать.
      </p>

      <div v-for="(b, i) in result.outputs" :key="i" class="block">
        <div class="block__head">
          <span class="block__title">{{ b.title }}</span>
          <button class="btn btn--copy" :class="{ 'btn--copied': copiedKey === String(i) }" @click="copyCode(i, b.code)">
            {{ copiedKey === String(i) ? "Скопировано ✓" : "Copy" }}
          </button>
        </div>
        <pre class="block__code">{{ b.code }}</pre>
      </div>
    </div>

    <!-- placeholder before any result -->
    <div v-else class="placeholder">
      <div class="placeholder__icon">🧩</div>
      <div class="placeholder__text">
        Здесь появятся Smartico-функции.<br />
        Загрузите ZIP и нажмите «Сгенерировать».
      </div>
    </div>
    </div>
    <!-- /RIGHT -->
  </div>
</template>

<style scoped>
.smartico {
  display: flex;
  align-items: flex-start;
  gap: 24px;
  width: 100%;
}
.smartico__left,
.smartico__right {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
/* Scroll only once functions exist — nothing scrolls before generation. */
.smartico__right--results {
  position: sticky;
  top: 16px;
  max-height: calc(100vh - 32px);
  overflow-y: auto;
}

/* result placeholder */
.placeholder {
  border: 2px dashed var(--color-border);
  border-radius: var(--radius-lg);
  padding: 48px 24px;
  text-align: center;
  color: var(--color-grey);
}
.placeholder__icon {
  font-size: 40px;
  margin-bottom: 10px;
}
.placeholder__text {
  font-size: 14px;
  line-height: 1.5;
}

@media (max-width: 900px) {
  .smartico {
    flex-direction: column;
  }
  .smartico__right--results {
    position: static;
    max-height: none;
    overflow-y: visible;
  }
}

/* drop zone */
.drop {
  border: 2px dashed var(--color-border);
  border-radius: var(--radius-lg);
  padding: 48px 24px;
  text-align: center;
  cursor: pointer;
  background: var(--color-bg);
  transition: border-color 0.15s ease, background 0.15s ease;
}
.drop:hover,
.drop--over {
  border-color: var(--color-accent);
  background: var(--color-bubble);
}
.drop--busy {
  cursor: default;
}
.drop__icon {
  font-size: 44px;
  line-height: 1;
  margin-bottom: 10px;
}
.drop__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text);
}
.drop__hint {
  margin-top: 8px;
  font-size: 13px;
  color: var(--color-grey);
}
.drop__hint code {
  background: var(--color-bubble);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 12px;
}

/* progress bar */
.bar {
  margin-top: 16px;
  height: 8px;
  width: 100%;
  background: var(--color-bubble);
  border-radius: 4px;
  overflow: hidden;
}
.bar__fill {
  height: 100%;
  background: var(--gradient-active);
  border-radius: 4px;
  transition: width 0.3s ease;
}
.bar__text {
  margin-top: 6px;
  font-size: 12px;
  color: var(--color-grey);
  text-align: center;
}

/* panels */
.panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.panel--center {
  align-items: center;
  text-align: center;
  padding: 32px 0;
}

.filemeta {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--color-border);
}
.filemeta__name {
  font-weight: 600;
  color: var(--color-text);
}
.filemeta__sub {
  font-size: 13px;
  color: var(--color-grey);
}
.filemeta .btn {
  margin-left: auto;
}

/* alerts */
.alert {
  margin: 0;
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  font-size: 14px;
}
.alert--error {
  background: rgba(244, 115, 115, 0.12);
  color: var(--color-stop-hover);
  border: 1px solid var(--color-stop);
}
.alert--warn {
  background: rgba(244, 175, 64, 0.14);
  color: #b9791b;
  border: 1px solid rgba(244, 175, 64, 0.5);
}

/* type checkboxes */
.field__label {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  margin-bottom: 10px;
}
.types {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.type {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 18px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-white);
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.type:hover {
  border-color: var(--color-accent);
}
.type--on {
  border-color: var(--color-accent);
  background: var(--color-bubble);
}
.type--off {
  opacity: 0.45;
  cursor: not-allowed;
}
.type--off:hover {
  border-color: var(--color-border);
}
.type__icon {
  font-size: 16px;
}

/* brands list */
.brands {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 12px 16px;
  background: var(--color-white);
}
.brands summary {
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
}
.brands__list {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  max-height: 240px;
  overflow-y: auto;
}
.brands__list li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  border-bottom: 1px solid var(--color-border);
  font-size: 13px;
}
.brands__row--warn {
  color: #b9791b;
}
.brands__name {
  color: var(--color-text);
}
.brands__canon {
  color: var(--color-grey);
  font-size: 12px;
}
.brands__types {
  color: var(--color-grey);
  font-size: 12px;
  white-space: nowrap;
}
.tag {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  background: var(--color-bubble);
  color: var(--color-grey);
  margin-left: 6px;
}
.tag--warn {
  background: rgba(244, 175, 64, 0.2);
  color: #b9791b;
}
.tag--ko {
  background: rgba(102, 126, 234, 0.18);
  color: #4d5bd0;
}

/* buttons */
.btn {
  border: none;
  border-radius: var(--radius-sm);
  padding: 9px 18px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.btn--primary {
  background: var(--gradient-active);
  color: var(--color-white);
  align-self: flex-start;
}
.btn--primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn--ghost {
  background: var(--color-white);
  border: 1px solid var(--color-border);
  color: var(--color-grey);
  padding: 6px 14px;
}
.btn--ghost:hover {
  color: var(--color-text);
  border-color: var(--color-grey);
}
.btn--copy {
  background: var(--color-white);
  border: 1px solid var(--color-border);
  color: var(--color-text);
  padding: 5px 16px;
  font-size: 13px;
}
.btn--copy:hover {
  border-color: var(--color-accent);
}
.btn--copied {
  background: rgba(72, 187, 120, 0.14);
  border-color: #48bb78;
  color: #276749;
}

/* output blocks */
.block {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.block__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-border);
}
.block__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
}
.block__code {
  margin: 0;
  padding: 16px;
  background: #1a202c;
  color: #e2e8f0;
  font-family: "Fira Code", "Consolas", monospace;
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 420px;
  overflow-y: auto;
}

/* spinner */
.spinner {
  width: 34px;
  height: 34px;
  border: 3px solid var(--color-bubble);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
.gen__status {
  font-size: 14px;
  color: var(--color-grey);
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
