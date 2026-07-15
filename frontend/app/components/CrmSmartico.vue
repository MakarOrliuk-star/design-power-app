<script setup lang="ts">

import { ref, computed, onUnmounted, onMounted } from "vue";
import { useImageTextScanner, type TextWarning } from "~/composables/useImageTextScanner";

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
  textWarnings?: TextWarning[]; // optional: старые завершённые джобы поля не имеют
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

// `driveReturn` is the ?drive=... outcome captured by the parent (crm.vue) on a
// Google OAuth return, passed in as a prop so this component doesn't depend on
// the URL (which the parent scrubs right after).
const props = defineProps<{ driveReturn?: string | null }>();

const config = useRuntimeConfig();
const api = useApi();
const { copiedKey, markCopied } = useCopied(1800);

// Two input sources, one shared result column. "zip" = upload an archive (legacy
// flow); "drive" = pick a folder from the shared Google Drive.
type Mode = "zip" | "drive";
const mode = ref<Mode>("zip");

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

// Текст-скан email-картинок (TASK Трек A): поп-ап + баннер по result.textWarnings.
const {
  activeWarnings: textWarnings,
  hasWarnings: hasTextWarnings,
  popupOpen: textPopupOpen,
  pending: textMarkPending,
  markError: textMarkError,
  setWarnings: setTextWarnings,
  openPopup: openTextPopup,
  closePopup: closeTextPopup,
  markOk: markTextOk,
  reset: resetTextScan,
} = useImageTextScanner(api);

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
  resetTextScan();
  if (fileInput.value) fileInput.value.value = "";
}

// ============================ Google Drive mode ============================
type DriveType = "email" | "pop-up" | "push";
interface DriveFolder { id: string; name: string }

const DRIVE_TYPE_UI: { id: DriveType; label: string; icon: string }[] = [
  { id: "email", label: "Email", icon: "📧" },
  { id: "pop-up", label: "Pop-up", icon: "💬" },
  { id: "push", label: "Push", icon: "🔔" },
];

const DRIVE_ERROR_TEXT: Record<string, string> = {
  drive_not_connected: "Google Drive не подключён — нажмите «Подключить».",
  invalid_drive_url: "Не похоже на ссылку Google Drive.",
  invalid_body: "Неверные данные запроса.",
  unexpected_root: "Это не та корневая папка. Вставьте ссылку на «Promotional packs».",
  drive_folder_not_found: "Папка не найдена или нет доступа.",
  drive_not_configured: "Google Drive не настроен на сервере.",
  drive_error: "Ошибка Google Drive. Попробуйте ещё раз.",
  no_brands: "В выбранной ветке не найдено папок брендов.",
  no_events: "Внутри бренда не найдено папок событий.",
};

const driveConfigured = ref(true);
const driveConnected = ref(false);
const driveStatusReady = ref(false);

const driveSelectedTypes = ref<DriveType[]>(["email", "pop-up", "push"]);
// Tournament-only Smartico card.webp (TASK D3): an extra function built from the
// SMARTICO/card.webp folder, in addition to the CRM-type functions.
const includeSmartico = ref(false);
const driveUrl = ref("");
type DriveStep = "idle" | "branch" | "event";
const driveStep = ref<DriveStep>("idle");
const driveBusy = ref(false);
const driveError = ref("");

const rootName = ref("");
const branches = ref<DriveFolder[]>([]);
const selectedBranch = ref<DriveFolder | null>(null);
const events = ref<DriveFolder[]>([]);
const selectedEvent = ref("");

const canGenerateDrive = computed(
  () =>
    driveStep.value === "event" &&
    !!selectedEvent.value &&
    driveSelectedTypes.value.length > 0,
);

// The Smartico card.webp checkbox only makes sense for Tournament branches
// (the only ones with a SMARTICO/card.webp folder). Mirrors the backend guard.
const isTournamentBranch = computed(() =>
  /tournament/i.test(selectedBranch.value?.name ?? ""),
);

function driveErrText(code: string | undefined): string {
  return (code && DRIVE_ERROR_TEXT[code]) || DRIVE_ERROR_TEXT.drive_error!;
}

function handleDriveErr(e: unknown) {
  const code = (e as { data?: { error?: string } })?.data?.error;
  if (code === "drive_not_connected") driveConnected.value = false;
  driveError.value = driveErrText(code);
}

function toggleDriveType(t: DriveType) {
  const i = driveSelectedTypes.value.indexOf(t);
  if (i >= 0) driveSelectedTypes.value.splice(i, 1);
  else driveSelectedTypes.value.push(t);
}

function resetDriveWizard() {
  driveStep.value = "idle";
  driveError.value = "";
  rootName.value = "";
  branches.value = [];
  selectedBranch.value = null;
  events.value = [];
  selectedEvent.value = "";
  includeSmartico.value = false;
}

async function fetchDriveStatus() {
  try {
    const s = await api<{ configured: boolean; connected: boolean }>(
      "/api/smartico/drive/status",
    );
    driveConfigured.value = s.configured;
    driveConnected.value = s.connected;
  } catch {
    driveConnected.value = false;
  } finally {
    driveStatusReady.value = true;
  }
}

// OAuth is a top-level redirect (same-origin proxy, like the login button). The
// callback returns to /crm?drive=connected, handled in onMounted below.
function connectDrive() {
  window.location.href = `${config.public.apiBase}/auth/google/drive`;
}

async function analyzeDrive() {
  driveError.value = "";
  const url = driveUrl.value.trim();
  if (!url) {
    driveError.value = "Вставьте ссылку на папку.";
    return;
  }
  driveBusy.value = true;
  try {
    const r = await api<{ rootId: string; rootName: string; folders: DriveFolder[] }>(
      "/api/smartico/drive/resolve",
      { method: "POST", body: { url } },
    );
    rootName.value = r.rootName;
    branches.value = r.folders;
    selectedBranch.value = null;
    events.value = [];
    selectedEvent.value = "";
    driveStep.value = "branch";
  } catch (e) {
    handleDriveErr(e);
  } finally {
    driveBusy.value = false;
  }
}

async function listChildren(folderId: string): Promise<DriveFolder[]> {
  const r = await api<{ folders: DriveFolder[] }>(
    `/api/smartico/drive/children?folderId=${encodeURIComponent(folderId)}`,
  );
  return r.folders;
}

// Pick a branch (Maiking / Tournaments) → read the FIRST brand's subfolders to
// offer the event list (every brand shares the same events). The user never
// picks a brand — generation later walks them all.
async function pickBranch(b: DriveFolder) {
  driveError.value = "";
  driveBusy.value = true;
  selectedBranch.value = b;
  selectedEvent.value = "";
  includeSmartico.value = false;
  try {
    const brandFolders = await listChildren(b.id);
    if (!brandFolders.length) {
      driveError.value = DRIVE_ERROR_TEXT.no_brands!;
      return;
    }
    const evs = await listChildren(brandFolders[0]!.id);
    if (!evs.length) {
      driveError.value = DRIVE_ERROR_TEXT.no_events!;
      return;
    }
    events.value = evs;
    driveStep.value = "event";
  } catch (e) {
    handleDriveErr(e);
  } finally {
    driveBusy.value = false;
  }
}

function backToBranches() {
  driveError.value = "";
  driveStep.value = "branch";
  selectedEvent.value = "";
  events.value = [];
}

async function generateDrive() {
  if (!selectedBranch.value || !selectedEvent.value || driveSelectedTypes.value.length === 0) return;
  driveError.value = "";
  phase.value = "generating";
  genPct.value = 0;
  genStatus.value = "queued";
  result.value = null;
  try {
    const { jobId } = await api<{ jobId: string }>("/api/smartico/drive/generate", {
      method: "POST",
      body: {
        branchId: selectedBranch.value.id,
        branchName: selectedBranch.value.name,
        eventName: selectedEvent.value,
        selectedTypes: driveSelectedTypes.value,
        includeSmartico: isTournamentBranch.value && includeSmartico.value,
      },
    });
    pollJob(jobId);
  } catch (e) {
    phase.value = "error";
    handleDriveErr(e);
  }
}

function setMode(m: Mode) {
  if (mode.value === m) return;
  reset(); // clears generation + ZIP state (shared right column)
  resetDriveWizard();
  mode.value = m;
  if (m === "drive" && !driveStatusReady.value) void fetchDriveStatus();
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
        setTextWarnings(res.result.textWarnings ?? []); // непустой список сам откроет поп-ап
        phase.value = "done";
        return;
      }
      if (res.status === "failed") {
        phase.value = "error";
        errorMsg.value = res.error
          ? `Генерация не удалась: ${res.error}`
          : "Генерация не удалась. Попробуйте ещё раз.";
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

onMounted(() => {
  void fetchDriveStatus();
  // Returned from the Drive consent flow. Land the user in Drive mode and surface
  // the outcome (the parent passes the ?drive=... value as a prop).
  const d = props.driveReturn;
  if (d) {
    mode.value = "drive";
    if (d === "connected") {
      driveConnected.value = true;
    } else {
      driveError.value =
        d === "denied"
          ? "Доступ к Google Drive отклонён."
          : "Не удалось подключить Google Drive. Попробуйте ещё раз.";
    }
  }
});

onUnmounted(() => {
  if (pollTimer) clearTimeout(pollTimer);
});
</script>

<template>
  <div class="smartico-wrap">
    <!-- Source switch: ZIP archive vs Google Drive -->
    <div class="modes">
      <button class="mode" :class="{ 'mode--on': mode === 'zip' }" type="button" @click="setMode('zip')">
        📦 ZIP-архив
      </button>
      <button class="mode" :class="{ 'mode--on': mode === 'drive' }" type="button" @click="setMode('drive')">
        🟢 Google Drive
      </button>
    </div>

  <div class="smartico">
    <!-- LEFT: upload + configure + generate -->
    <div class="smartico__left">
    <!-- ============================ ZIP source ============================ -->
    <template v-if="mode === 'zip'">
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
        Структура: <code>DES-XXXXX/Бренд/CRM/{email, pop-up_1, pop-up_2, push}</code>
        или <code>Бренд/{email, push, pop-up}</code> сразу в корне архива.
        <code>All brands</code> → дефолтная картинка (подставляется в else каждой функции),
        <code>Korea</code> / <code>Korea realistic</code> → отдельные KO-функции. До 100 МБ.
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
    </template>
    <!-- /ZIP source -->

    <!-- ========================== Google Drive source ========================== -->
    <template v-else>
      <!-- Format chosen up-front (before "Анализировать") -->
      <div class="field">
        <div class="field__label">Формат промо-акции</div>
        <div class="types">
          <label
            v-for="u in DRIVE_TYPE_UI"
            :key="u.id"
            class="type"
            :class="{ 'type--on': driveSelectedTypes.includes(u.id) }"
          >
            <input
              type="checkbox"
              :checked="driveSelectedTypes.includes(u.id)"
              @change="toggleDriveType(u.id)"
            />
            <span class="type__icon">{{ u.icon }}</span>
            {{ u.label }}
          </label>
        </div>
      </div>

      <!-- Checking connection -->
      <div v-if="!driveStatusReady" class="drive-loading">Проверка подключения к Google Drive…</div>

      <!-- Not connected → one-time consent -->
      <div v-else-if="!driveConnected" class="drive-connect">
        <div class="drop__icon">🔗</div>
        <div class="drop__title">Подключите Google Drive</div>
        <div class="drop__hint">
          Доступ только на чтение к общей папке «Promotional packs». Откроется окно
          согласия Google.
        </div>
        <button class="btn btn--primary" type="button" @click="connectDrive">
          Подключить Google Drive
        </button>
      </div>

      <!-- Connected → step-by-step wizard -->
      <template v-else>
        <!-- Step: paste folder URL -->
        <div v-if="driveStep === 'idle'" class="field">
          <div class="field__label">Ссылка на папку Google Drive</div>
          <div class="urlrow">
            <input
              v-model="driveUrl"
              class="urlinput"
              type="text"
              inputmode="url"
              placeholder="https://drive.google.com/drive/folders/…"
              @keydown.enter="analyzeDrive"
            />
            <button class="btn btn--primary" :disabled="driveBusy" @click="analyzeDrive">
              {{ driveBusy ? "…" : "Анализировать" }}
            </button>
          </div>
        </div>

        <!-- Step: pick a branch (Maiking / Tournaments) -->
        <div v-else-if="driveStep === 'branch'" class="picker">
          <div class="picker__head">
            <span class="filemeta__name">📁 {{ rootName }}</span>
            <button class="btn btn--ghost" @click="resetDriveWizard">Другая ссылка</button>
          </div>
          <div class="field__label">Выберите раздел</div>
          <div class="folders">
            <button
              v-for="b in branches"
              :key="b.id"
              class="folder"
              :disabled="driveBusy"
              @click="pickBranch(b)"
            >📂 {{ b.name }}</button>
          </div>
        </div>

        <!-- Step: pick an event -->
        <div v-else class="picker">
          <div class="picker__head">
            <span class="filemeta__name">📁 {{ selectedBranch?.name }}</span>
            <button class="btn btn--ghost" @click="backToBranches">← Разделы</button>
          </div>
          <div class="field__label">Выберите событие</div>
          <div class="folders">
            <button
              v-for="e in events"
              :key="e.id"
              class="folder"
              :class="{ 'folder--on': selectedEvent === e.name }"
              @click="selectedEvent = e.name"
            >🏆 {{ e.name }}</button>
          </div>

          <!-- Tournament-only: add a separate Smartico card.webp function -->
          <label v-if="isTournamentBranch" class="smartico-opt">
            <input type="checkbox" v-model="includeSmartico" />
            <span class="type__icon">🃏</span>
            <span>
              Smartico <code>card.webp</code> — отдельная функция
            </span>
          </label>

          <button
            class="btn btn--primary"
            :disabled="!canGenerateDrive || phase === 'generating'"
            @click="generateDrive"
          >
            {{ phase === "generating" ? "Генерация…" : `Сгенерировать (${driveSelectedTypes.length})` }}
          </button>
        </div>
      </template>

      <p v-if="driveBusy && driveStep !== 'idle'" class="bar__text">Чтение Google Drive…</p>
      <p v-if="driveError" class="alert alert--error">{{ driveError }}</p>
      <p v-if="phase === 'error' && errorMsg" class="alert alert--error">{{ errorMsg }}</p>
    </template>
    <!-- /Google Drive source -->
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
        <button class="btn btn--ghost" @click="reset">{{ mode === "drive" ? "Заново" : "Новый ZIP" }}</button>
      </div>

      <p v-if="result.stats.failed" class="alert alert--warn">
        Не загрузились: {{ result.stats.failedItems.join(", ") }}
      </p>

      <!-- Текст-скан: баннер остаётся, пока предупреждения не помечены «ок» -->
      <p v-if="hasTextWarnings" class="alert alert--warn textwarn-banner">
        ⚠️ Обнаружен текст на email-картинках: {{ textWarnings.length }}.
        <button class="textwarn-banner__btn" type="button" @click="openTextPopup">
          Показать
        </button>
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
        {{ mode === "drive"
          ? "Выберите событие в Google Drive и нажмите «Сгенерировать»."
          : "Загрузите ZIP и нажмите «Сгенерировать»." }}
      </div>
    </div>
    </div>
    <!-- /RIGHT -->
  </div>

  <TextWarningsPopup
    :open="textPopupOpen"
    :warnings="textWarnings"
    :pending="textMarkPending"
    :error="textMarkError"
    @close="closeTextPopup"
    @mark-ok="markTextOk"
  />
  </div>
</template>

<style scoped>
.smartico-wrap {
  display: flex;
  flex-direction: column;
  gap: 18px;
  width: 100%;
}

/* source switch (ZIP / Google Drive) */
.modes {
  display: inline-flex;
  gap: 6px;
  padding: 4px;
  background: var(--color-bubble);
  border-radius: var(--radius-pill);
  align-self: flex-start;
}
.mode {
  border: none;
  background: transparent;
  padding: 8px 18px;
  border-radius: var(--radius-pill);
  font-size: 14px;
  font-weight: 600;
  color: var(--color-grey);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.mode--on {
  background: var(--color-white);
  color: var(--color-text);
  box-shadow: var(--shadow-card);
}

.smartico {
  display: flex;
  align-items: flex-start;
  gap: 24px;
  width: 100%;
}

/* Drive: connection states */
.drive-loading {
  padding: 28px 0;
  text-align: center;
  font-size: 14px;
  color: var(--color-grey);
}
.drive-connect {
  border: 2px dashed var(--color-border);
  border-radius: var(--radius-lg);
  padding: 36px 24px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.drive-connect .btn {
  margin-top: 8px;
}

/* Drive: url input row */
.urlrow {
  display: flex;
  gap: 10px;
}
.urlinput {
  flex: 1 1 auto;
  min-width: 0;
  padding: 10px 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 14px;
  color: var(--color-text);
  background: var(--color-white);
}
.urlinput:focus {
  outline: none;
  border-color: var(--color-accent);
}

/* Drive: folder pickers (branches, events) */
.picker {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.picker__head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--color-border);
}
.picker__head .btn {
  margin-left: auto;
}
.folders {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
}
.folder {
  text-align: left;
  border: 1px solid var(--color-border);
  background: var(--color-white);
  border-radius: var(--radius-md);
  padding: 12px 16px;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.folder:hover:not(:disabled) {
  border-color: var(--color-accent);
  background: var(--color-bubble);
}
.folder--on {
  border-color: var(--color-accent);
  background: var(--color-bubble);
}
.folder:disabled {
  opacity: 0.55;
  cursor: default;
}
/* Tournament-only Smartico card.webp opt-in */
.smartico-opt {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-white);
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
  cursor: pointer;
  align-self: flex-start;
}
.smartico-opt code {
  background: var(--color-bubble);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
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

/* text-scan banner (TASK Трек A) */
.textwarn-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.textwarn-banner__btn {
  border: 1px solid rgba(244, 175, 64, 0.7);
  background: var(--color-white);
  color: #b9791b;
  border-radius: var(--radius-sm);
  padding: 4px 12px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.textwarn-banner__btn:hover {
  background: rgba(244, 175, 64, 0.18);
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
