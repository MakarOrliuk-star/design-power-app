<script setup lang="ts">
// Admin: manage the email allowlist and existing users (role / activation).
useHead({ title: "Design Power — Admin" });

interface AllowedEmail {
  id: string;
  email: string;
  note: string | null;
  addedBy: string | null;
  createdAt: string;
}
interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: "ADMIN" | "DESIGNER" | "CRM" | "MANAGER";
  isActive: boolean;
  lastLoginAt: string | null;
}

const api = useApi();
const auth = useAuthStore();

const allowedEmails = ref<AllowedEmail[]>([]);
const users = ref<AdminUser[]>([]);
const newEmail = ref("");
const newNote = ref("");
const error = ref("");
const loading = ref(false);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [a, u] = await Promise.all([
      api<{ allowedEmails: AllowedEmail[] }>("/api/admin/allowed-emails"),
      api<{ users: AdminUser[] }>("/api/admin/users"),
    ]);
    allowedEmails.value = a.allowedEmails;
    users.value = u.users;
  } catch {
    error.value = "Не удалось загрузить данные.";
  } finally {
    loading.value = false;
  }
}

async function addEmail() {
  if (!newEmail.value.trim()) return;
  error.value = "";
  try {
    await api("/api/admin/allowed-emails", {
      method: "POST",
      body: { email: newEmail.value.trim(), note: newNote.value.trim() || undefined },
    });
    newEmail.value = "";
    newNote.value = "";
    await load();
  } catch {
    error.value = "Не удалось добавить email (возможно, уже есть в списке).";
  }
}

async function removeEmail(id: string) {
  await api(`/api/admin/allowed-emails/${id}`, { method: "DELETE" });
  await load();
}

async function patchUser(u: AdminUser, patch: Partial<Pick<AdminUser, "role" | "isActive">>) {
  try {
    await api(`/api/admin/users/${u.id}`, { method: "PATCH", body: patch });
    await load();
  } catch {
    error.value = "Не удалось обновить пользователя.";
  }
}

// ---- Catalog: brand references (NanoRef) + prompts ----
interface AdminBrand {
  id: string;
  name: string;
  forcedAspectRatio: string | null; // "9:16" = форс формата (TASK §7), null = по выбору юзера
  imageModel: string | null; // ключ модели fal (Task 1); null = nano-banana-2 по умолчанию
  referenceImages: string[];
  personPrompt: string;
}
interface ItemPrompt {
  key: string;
  content: string;
}
interface BrandCategory {
  id: string;
  name: string;
}
interface ModelOption {
  key: string;
  label: string;
}

const brands = ref<AdminBrand[]>([]);
const categories = ref<BrandCategory[]>([]);
const itemPrompts = ref<ItemPrompt[]>([]);
const models = ref<ModelOption[]>([]);

// ---- Create brand (TASK §2) ----
function emptyNewBrand() {
  return {
    name: "",
    categoryIds: [] as string[],
    personPrompt: "",
    stylePrompt: "",
    referenceImages: ["", "", ""], // 3 ref slots (Cloudinary URLs)
    force916: false, // TASK §7: новый бренд по умолчанию следует выбору юзера
  };
}
const newBrand = ref(emptyNewBrand());
const creatingBrand = ref(false);
const createMsg = ref("");

function toggleNewBrandCategory(id: string) {
  const arr = newBrand.value.categoryIds;
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(id);
}

async function uploadNewBrandRef(slot: number, e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  createMsg.value = "Загрузка картинки…";
  try {
    const dataUrl = await fileToDataUrl(file);
    const res = await api<{ secure_url: string }>("/api/admin/upload", {
      method: "POST",
      body: { dataUrl },
    });
    newBrand.value.referenceImages[slot] = res.secure_url;
    createMsg.value = "Картинка загружена.";
  } catch {
    createMsg.value = "Ошибка загрузки картинки.";
  }
}

async function createBrand() {
  const name = newBrand.value.name.trim();
  if (!name) return;
  creatingBrand.value = true;
  createMsg.value = "";
  try {
    await api("/api/admin/brands", {
      method: "POST",
      body: {
        name,
        categoryIds: newBrand.value.categoryIds,
        personPrompt: newBrand.value.personPrompt,
        stylePrompt: newBrand.value.stylePrompt,
        referenceImages: newBrand.value.referenceImages.map((s) => s.trim()).filter(Boolean),
        forcedAspectRatio: newBrand.value.force916 ? "9:16" : null,
      },
    });
    createMsg.value = "Бренд создан ✓";
    newBrand.value = emptyNewBrand();
    await loadCatalog();
  } catch (e: unknown) {
    const code = (e as { data?: { error?: string } })?.data?.error;
    createMsg.value =
      code === "already_exists" ? "Бренд с таким именем уже существует." : "Не удалось создать бренд.";
  } finally {
    creatingBrand.value = false;
  }
}
const brandSearch = ref("");
const savingId = ref<string | null>(null);
const rowMsg = ref<Record<string, string>>({});
const itemMsg = ref<Record<string, string>>({});

const onlyIncomplete = ref(false);

function refCount(b: AdminBrand): number {
  return b.referenceImages.filter((s) => s.trim()).length;
}
function isComplete(b: AdminBrand): boolean {
  return refCount(b) === 3 && b.personPrompt.trim().length > 0;
}

const filteredBrands = computed(() => {
  const q = brandSearch.value.trim().toLowerCase();
  return brands.value.filter((b) => {
    if (q && !b.name.toLowerCase().includes(q)) return false;
    if (onlyIncomplete.value && isComplete(b)) return false;
    return true;
  });
});

function padTo3(arr: string[]): string[] {
  const a = [...arr];
  while (a.length < 3) a.push("");
  return a.slice(0, 3);
}

async function loadCatalog() {
  try {
    const res = await api<{
      brands: AdminBrand[];
      categories: BrandCategory[];
      itemPrompts: ItemPrompt[];
      models: ModelOption[];
    }>("/api/admin/catalog");
    brands.value = res.brands.map((b) => ({ ...b, referenceImages: padTo3(b.referenceImages) }));
    categories.value = res.categories;
    itemPrompts.value = res.itemPrompts;
    models.value = res.models ?? [];
  } catch {
    error.value = "Не удалось загрузить каталог.";
  }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function uploadRef(b: AdminBrand, slot: number, e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  rowMsg.value[b.id] = "Загрузка…";
  try {
    const dataUrl = await fileToDataUrl(file);
    const res = await api<{ secure_url: string }>("/api/admin/upload", { method: "POST", body: { dataUrl } });
    b.referenceImages[slot] = res.secure_url;
    rowMsg.value[b.id] = "Картинка загружена — нажми Сохранить";
  } catch {
    rowMsg.value[b.id] = "Ошибка загрузки картинки";
  }
}

function toggleForce916(b: AdminBrand) {
  b.forcedAspectRatio = b.forcedAspectRatio === "9:16" ? null : "9:16";
}

/** Human label for a brand's model override key (for the badge). */
function modelLabelFor(key: string | null): string {
  if (!key) return "";
  return models.value.find((m) => m.key === key)?.label ?? key;
}

async function saveBrand(b: AdminBrand) {
  savingId.value = b.id;
  rowMsg.value[b.id] = "";
  try {
    const referenceImages = b.referenceImages.map((s) => s.trim()).filter(Boolean);
    await api(`/api/admin/brands/${b.id}/nanoref`, { method: "PUT", body: { referenceImages } });
    await api("/api/admin/prompt", {
      method: "PUT",
      body: { type: "PERSON", key: b.name, content: b.personPrompt, brandId: b.id },
    });
    await api(`/api/admin/brands/${b.id}`, {
      method: "PATCH",
      body: { forcedAspectRatio: b.forcedAspectRatio, imageModel: b.imageModel },
    });
    rowMsg.value[b.id] = "Сохранено ✓";
  } catch {
    rowMsg.value[b.id] = "Ошибка сохранения";
  } finally {
    savingId.value = null;
  }
}

async function saveItemPrompt(p: ItemPrompt) {
  itemMsg.value[p.key] = "";
  try {
    await api("/api/admin/prompt", { method: "PUT", body: { type: "ITEM", key: p.key, content: p.content } });
    itemMsg.value[p.key] = "Сохранено ✓";
  } catch {
    itemMsg.value[p.key] = "Ошибка";
  }
}

// ---- Create Item style: new PromptTemplate(ITEM) key => появляется в пикере Home ----
const newItemKey = ref("");
const newItemContent = ref("");
const creatingItem = ref(false);
const newItemMsg = ref("");

async function createItemStyle() {
  const key = newItemKey.value.trim();
  if (!key) return;
  // PUT /prompt — это upsert: без проверки молча перезаписали бы существующий стиль.
  if (itemPrompts.value.some((p) => p.key.toLowerCase() === key.toLowerCase())) {
    newItemMsg.value = "Стиль с таким именем уже существует.";
    return;
  }
  creatingItem.value = true;
  newItemMsg.value = "";
  try {
    await api("/api/admin/prompt", {
      method: "PUT",
      body: { type: "ITEM", key, content: newItemContent.value },
    });
    newItemMsg.value = "Стиль создан ✓";
    newItemKey.value = "";
    newItemContent.value = "";
    await loadCatalog();
  } catch {
    newItemMsg.value = "Не удалось создать стиль.";
  } finally {
    creatingItem.value = false;
  }
}

// ---- Smartico brands (Unique-Image-Smartico maintenance) ----
interface SmarticoBrand {
  id: string;
  name: string;
  createdAt: string;
}

const smarticoBrands = ref<SmarticoBrand[]>([]);
const newSmarticoName = ref("");
const smarticoSearch = ref("");
const smarticoMsg = ref("");
const editingId = ref<string | null>(null);
const editingName = ref("");

const filteredSmarticoBrands = computed(() => {
  const q = smarticoSearch.value.trim().toLowerCase();
  if (!q) return smarticoBrands.value;
  return smarticoBrands.value.filter((b) => b.name.toLowerCase().includes(q));
});

async function loadSmarticoBrands() {
  try {
    const res = await api<{ smarticoBrands: SmarticoBrand[] }>("/api/admin/smartico-brands");
    smarticoBrands.value = res.smarticoBrands;
  } catch {
    error.value = "Не удалось загрузить Smartico-бренды.";
  }
}

async function addSmarticoBrand() {
  const name = newSmarticoName.value.trim();
  if (!name) return;
  smarticoMsg.value = "";
  try {
    await api("/api/admin/smartico-brands", { method: "POST", body: { name } });
    newSmarticoName.value = "";
    smarticoMsg.value = "Добавлено ✓";
    await loadSmarticoBrands();
  } catch (e: unknown) {
    const code = (e as { data?: { error?: string } })?.data?.error;
    smarticoMsg.value = code === "already_exists" ? "Такой бренд уже есть." : "Не удалось добавить.";
  }
}

function startEditSmarticoBrand(b: SmarticoBrand) {
  editingId.value = b.id;
  editingName.value = b.name;
}
function cancelEditSmarticoBrand() {
  editingId.value = null;
  editingName.value = "";
}

async function saveSmarticoBrand(b: SmarticoBrand) {
  const name = editingName.value.trim();
  if (!name || name === b.name) {
    cancelEditSmarticoBrand();
    return;
  }
  smarticoMsg.value = "";
  try {
    await api(`/api/admin/smartico-brands/${b.id}`, { method: "PATCH", body: { name } });
    cancelEditSmarticoBrand();
    await loadSmarticoBrands();
  } catch (e: unknown) {
    const code = (e as { data?: { error?: string } })?.data?.error;
    smarticoMsg.value = code === "already_exists" ? "Такое имя уже занято." : "Не удалось переименовать.";
  }
}

async function removeSmarticoBrand(b: SmarticoBrand) {
  smarticoMsg.value = "";
  try {
    await api(`/api/admin/smartico-brands/${b.id}`, { method: "DELETE" });
    await loadSmarticoBrands();
  } catch {
    smarticoMsg.value = "Не удалось удалить.";
  }
}

// ---- Tournaments (Phase 4): elements, default prompts, provider refs ----
// ADMIN and MANAGER both edit this section; every other panel is ADMIN-only
// (mirrors the backend: /api/tournament-admin vs /api/admin).
type TourMode = "BASE" | "VIP";
interface TourPrompt {
  mode: TourMode;
  content: string;
  updatedAt: string;
}
interface TourElement {
  id: string;
  name: string;
  order: number;
  isActive: boolean;
  referenceImages: string[];
  prompts: TourPrompt[];
}
interface TourCategory {
  id: string;
  key: string;
  name: string;
  hasModes: boolean;
  fixedMode: TourMode | null;
  order: number;
  elements: TourElement[];
}

const tourCategories = ref<TourCategory[]>([]);
const tourSystemPrompt = ref("");
const tourMsg = ref<Record<string, string>>({}); // element id | "system" | category id
const newElementName = ref<Record<string, string>>({}); // per category id

function padTo2(arr: string[]): string[] {
  const a = [...arr];
  while (a.length < 2) a.push("");
  return a.slice(0, 2);
}

/** Stable BASE→VIP order for the prompt textareas of a moded category. */
function sortedPrompts(el: TourElement): TourPrompt[] {
  return [...el.prompts].sort((a, b) => (a.mode === b.mode ? 0 : a.mode === "BASE" ? -1 : 1));
}

async function loadTournaments() {
  try {
    const res = await api<{ categories: TourCategory[]; systemPrompt: string }>(
      "/api/tournament-admin/config",
    );
    tourCategories.value = res.categories.map((c) => ({
      ...c,
      elements: c.elements.map((e) => ({
        ...e,
        referenceImages: c.key === "provider" ? padTo2(e.referenceImages) : e.referenceImages,
      })),
    }));
    tourSystemPrompt.value = res.systemPrompt;
  } catch {
    error.value = "Не удалось загрузить турниры.";
  }
}

// ---- Category CRUD (key = ZIP folder, generated once from the name) ----
const newCatName = ref("");
const newCatMode = ref<"BOTH" | "BASE" | "VIP">("BOTH");

async function addTourCategory() {
  const name = newCatName.value.trim();
  if (!name) return;
  tourMsg.value.newcat = "";
  try {
    await api("/api/tournament-admin/categories", {
      method: "POST",
      body: {
        name,
        hasModes: newCatMode.value === "BOTH",
        fixedMode: newCatMode.value === "BOTH" ? null : newCatMode.value,
      },
    });
    newCatName.value = "";
    tourMsg.value.newcat = "Категория создана ✓";
    await loadTournaments();
  } catch {
    tourMsg.value.newcat = "Не удалось создать категорию.";
  }
}

async function saveTourCategory(cat: TourCategory) {
  tourMsg.value[cat.id] = "";
  try {
    await api(`/api/tournament-admin/categories/${cat.id}`, {
      method: "PATCH",
      body: { name: cat.name.trim() },
    });
    tourMsg.value[cat.id] = "Сохранено ✓";
  } catch {
    tourMsg.value[cat.id] = "Ошибка сохранения";
  }
}

/** Hard delete: элементы, дефолты и локальные правки уходят; история генераций остаётся. */
async function deleteTourCategory(cat: TourCategory) {
  const n = cat.elements.length;
  const ok = window.confirm(
    `Удалить категорию «${cat.name}»${n ? ` вместе с ${n} элемент(ами)` : ""}?\n` +
      "Дефолтные промпты и локальные правки дизайнеров по этим элементам будут удалены. " +
      "История генераций и старые ZIP не пострадают.",
  );
  if (!ok) return;
  try {
    await api(`/api/tournament-admin/categories/${cat.id}`, { method: "DELETE" });
    tourCategories.value = tourCategories.value.filter((c) => c.id !== cat.id);
  } catch {
    tourMsg.value[cat.id] = "Не удалось удалить категорию.";
  }
}

async function addTourElement(cat: TourCategory) {
  const name = (newElementName.value[cat.id] ?? "").trim();
  if (!name) return;
  tourMsg.value[cat.id] = "";
  try {
    await api("/api/tournament-admin/elements", {
      method: "POST",
      body: { categoryId: cat.id, name },
    });
    newElementName.value[cat.id] = "";
    tourMsg.value[cat.id] = "Элемент добавлен ✓";
    await loadTournaments();
  } catch (e: unknown) {
    const code = (e as { data?: { error?: string } })?.data?.error;
    tourMsg.value[cat.id] =
      code === "already_exists" ? "Такой элемент уже есть." : "Не удалось добавить элемент.";
  }
}

async function saveTourPrompt(el: TourElement, p: TourPrompt) {
  tourMsg.value[el.id] = "";
  try {
    await api("/api/tournament-admin/prompts", {
      method: "PUT",
      body: { elementId: el.id, mode: p.mode, content: p.content },
    });
    tourMsg.value[el.id] = "Промпт сохранён ✓ (у пользователей с правкой появится плашка)";
  } catch {
    tourMsg.value[el.id] = "Ошибка сохранения промпта";
  }
}

/** Save the element's name (+ provider refs) — the card's Сохранить button. */
async function saveTourElement(cat: TourCategory, el: TourElement) {
  tourMsg.value[el.id] = "";
  try {
    const body: { name: string; referenceImages?: string[] } = { name: el.name.trim() };
    if (cat.key === "provider")
      body.referenceImages = el.referenceImages.map((s) => s.trim()).filter(Boolean);
    await api(`/api/tournament-admin/elements/${el.id}`, { method: "PATCH", body });
    tourMsg.value[el.id] = "Сохранено ✓";
  } catch (e: unknown) {
    const code = (e as { data?: { error?: string } })?.data?.error;
    tourMsg.value[el.id] =
      code === "already_exists" ? "Имя уже занято в этой категории." : "Ошибка сохранения";
  }
}

async function toggleTourActive(el: TourElement) {
  tourMsg.value[el.id] = "";
  try {
    await api(`/api/tournament-admin/elements/${el.id}`, {
      method: "PATCH",
      body: { isActive: !el.isActive },
    });
    el.isActive = !el.isActive;
    tourMsg.value[el.id] = el.isActive ? "Включён ✓" : "Выключен (скрыт у дизайнеров)";
  } catch {
    tourMsg.value[el.id] = "Ошибка";
  }
}

/** Removal is soft (isActive=false) — generation history keeps the name. */
async function deleteTourElement(el: TourElement) {
  tourMsg.value[el.id] = "";
  try {
    await api(`/api/tournament-admin/elements/${el.id}`, { method: "DELETE" });
    el.isActive = false;
    tourMsg.value[el.id] = "Выключен (скрыт у дизайнеров)";
  } catch {
    tourMsg.value[el.id] = "Ошибка";
  }
}

async function uploadTourRef(el: TourElement, slot: number, e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  tourMsg.value[el.id] = "Загрузка картинки…";
  try {
    const dataUrl = await fileToDataUrl(file);
    const res = await api<{ secure_url: string }>("/api/tournament-admin/upload", {
      method: "POST",
      body: { dataUrl },
    });
    el.referenceImages[slot] = res.secure_url;
    tourMsg.value[el.id] = "Картинка загружена — нажми Сохранить";
  } catch {
    tourMsg.value[el.id] = "Ошибка загрузки картинки";
  }
}

async function saveTourSystemPrompt() {
  tourMsg.value.system = "";
  try {
    await api("/api/tournament-admin/system-prompt", {
      method: "PUT",
      body: { content: tourSystemPrompt.value },
    });
    tourMsg.value.system = "Сохранено ✓";
  } catch {
    tourMsg.value.system = "Ошибка сохранения";
  }
}

onMounted(() => {
  // MANAGER only reaches the Tournaments section — the ADMIN-only loads would
  // just 403 on /api/admin, so they are skipped entirely.
  if (auth.isAdmin) {
    void load();
    void loadCatalog();
    void loadSmarticoBrands();
  }
  void loadTournaments();
});
</script>

<template>
  <div class="admin">
    <h1>Администрирование</h1>
    <p v-if="error" class="error">{{ error }}</p>

    <section v-if="auth.isAdmin" class="panel">
      <h2>Белый список email</h2>
      <form class="add-form" @submit.prevent="addEmail">
        <input v-model="newEmail" type="email" placeholder="email@example.com" required />
        <input v-model="newNote" type="text" placeholder="Заметка (необязательно)" />
        <button type="submit" class="btn-primary">Добавить</button>
      </form>

      <table class="table">
        <thead>
          <tr><th>Email</th><th>Заметка</th><th>Добавил</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="row in allowedEmails" :key="row.id">
            <td>{{ row.email }}</td>
            <td>{{ row.note || "—" }}</td>
            <td>{{ row.addedBy || "—" }}</td>
            <td><button class="btn-danger" @click="removeEmail(row.id)">Удалить</button></td>
          </tr>
          <tr v-if="!allowedEmails.length && !loading">
            <td colspan="4" class="muted">Список пуст.</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="auth.isAdmin" class="panel">
      <h2>Пользователи</h2>
      <table class="table">
        <thead>
          <tr><th>Email</th><th>Имя</th><th>Роль</th><th>Активен</th></tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td>{{ u.email }}</td>
            <td>{{ u.name || "—" }}</td>
            <td>
              <select
                :value="u.role"
                :disabled="u.id === auth.user?.id"
                @change="patchUser(u, { role: ($event.target as HTMLSelectElement).value as 'ADMIN' | 'DESIGNER' | 'CRM' | 'MANAGER' })"
              >
                <option value="DESIGNER">DESIGNER</option>
                <option value="CRM">CRM</option>
                <option value="MANAGER">MANAGER</option>
                <option value="ADMIN">ADMIN</option>
              </select>
            </td>
            <td>
              <button
                class="btn-toggle"
                :disabled="u.id === auth.user?.id"
                @click="patchUser(u, { isActive: !u.isActive })"
              >
                {{ u.isActive ? "Да" : "Нет" }}
              </button>
            </td>
          </tr>
          <tr v-if="!users.length && !loading">
            <td colspan="4" class="muted">Пользователей нет.</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- Create brand -->
    <section v-if="auth.isAdmin" class="panel">
      <h2>Создать бренд</h2>
      <p class="muted small">
        Имя бренда, категории, базовый промпт (PERSON) и специфичный стиль.
        Реф-картинки можно загрузить ниже после создания.
      </p>

      <form class="create-brand" @submit.prevent="createBrand">
        <div class="field">
          <label class="field__label">Название бренда</label>
          <input v-model="newBrand.name" class="field__input" type="text" placeholder="Напр. Spinogambino(Men)" required />
        </div>

        <div v-if="categories.length" class="field">
          <label class="field__label">Категории</label>
          <div class="cat-list">
            <label v-for="c in categories" :key="c.id" class="cat-chip">
              <input
                type="checkbox"
                :checked="newBrand.categoryIds.includes(c.id)"
                @change="toggleNewBrandCategory(c.id)"
              />
              {{ c.name }}
            </label>
          </div>
        </div>

        <div class="field">
          <label class="field__label">Базовый промпт (PERSON)</label>
          <textarea
            v-model="newBrand.personPrompt"
            class="prompt"
            rows="3"
            placeholder="Системный «prompt writer» для этого бренда (необязательно)"
          />
        </div>

        <div class="field">
          <label class="field__label">Специфичный стиль</label>
          <textarea
            v-model="newBrand.stylePrompt"
            class="prompt"
            rows="2"
            placeholder="Стилевое описание бренда (необязательно)"
          />
        </div>

        <div class="field">
          <label class="field__label">Формат генерации</label>
          <label class="checkbox">
            <input v-model="newBrand.force916" type="checkbox" />
            Всегда 9:16 — генерировать в 9:16, даже если на Home выбран 1:1
          </label>
        </div>

        <div class="field">
          <label class="field__label">Реф-картинки (до 3)</label>
          <div class="refs">
            <div v-for="(url, i) in newBrand.referenceImages" :key="i" class="ref">
              <div class="ref__preview">
                <img v-if="url" :src="url" alt="" />
                <span v-else class="ref__ph">Ref{{ i + 1 }}</span>
              </div>
              <input
                v-model="newBrand.referenceImages[i]"
                class="ref__url"
                type="text"
                :placeholder="`Ref${i + 1} URL`"
              />
              <label class="ref__upload">
                Загрузить
                <input type="file" accept="image/*" hidden @change="(e) => uploadNewBrandRef(i, e)" />
              </label>
            </div>
          </div>
        </div>

        <div class="create-brand__foot">
          <span v-if="createMsg" class="create-brand__msg">{{ createMsg }}</span>
          <button type="submit" class="btn-primary" :disabled="creatingBrand || !newBrand.name.trim()">
            {{ creatingBrand ? "Создание…" : "Создать бренд" }}
          </button>
        </div>
      </form>
    </section>

    <!-- Brand references + Person prompts -->
    <section v-if="auth.isAdmin" class="panel">
      <h2>Референсы и промпты брендов (Person)</h2>
      <p class="muted small">
        Ref1/Ref2/Ref3 — заготовленные картинки бренда (Cloudinary URL или загрузка файла).
        Промпт — системный «prompt writer» для nano-gpt; пусто = общий дефолт.
      </p>
      <div class="brand-filters">
        <input v-model="brandSearch" class="search" type="text" placeholder="Поиск бренда…" />
        <label class="checkbox">
          <input v-model="onlyIncomplete" type="checkbox" />
          Только незаполненные
        </label>
      </div>

      <div class="brand-list">
        <div v-for="b in filteredBrands" :key="b.id" class="brand-card">
          <div class="brand-card__head">
            <span class="brand-card__name">{{ b.name }}</span>
            <span class="badges">
              <span :class="['badge', refCount(b) === 3 ? 'badge--ok' : refCount(b) ? 'badge--warn' : 'badge--off']">
                рефы {{ refCount(b) }}/3
              </span>
              <span :class="['badge', b.personPrompt.trim() ? 'badge--ok' : 'badge--off']">
                {{ b.personPrompt.trim() ? "промпт ✓" : "промпт —" }}
              </span>
              <span v-if="b.forcedAspectRatio === '9:16'" class="badge badge--warn">всегда 9:16</span>
              <span v-if="b.imageModel" class="badge badge--warn">{{ modelLabelFor(b.imageModel) }}</span>
            </span>
            <span v-if="rowMsg[b.id]" class="brand-card__msg">{{ rowMsg[b.id] }}</span>
          </div>

          <div class="refs">
            <div v-for="(url, i) in b.referenceImages" :key="i" class="ref">
              <div class="ref__preview">
                <img v-if="url" :src="url" alt="" />
                <span v-else class="ref__ph">Ref{{ i + 1 }}</span>
              </div>
              <input v-model="b.referenceImages[i]" class="ref__url" type="text" :placeholder="`Ref${i + 1} URL`" />
              <label class="ref__upload">
                Загрузить
                <input type="file" accept="image/*" hidden @change="(e) => uploadRef(b, i, e)" />
              </label>
            </div>
          </div>

          <textarea
            v-model="b.personPrompt"
            class="prompt"
            rows="4"
            placeholder="Системный промпт PERSON для этого бренда (необязательно)"
          />

          <div class="brand-card__foot">
            <label class="checkbox" title="Генерировать в 9:16, даже если на Home выбран 1:1">
              <input
                type="checkbox"
                :checked="b.forcedAspectRatio === '9:16'"
                @change="toggleForce916(b)"
              />
              Всегда 9:16
            </label>
            <label class="model-select" title="Модель генерации fal.ai для этого бренда">
              Модель:
              <select v-model="b.imageModel">
                <option :value="null">Nano Banana 2 (по умолчанию)</option>
                <option v-for="m in models" :key="m.key" :value="m.key">{{ m.label }}</option>
              </select>
            </label>
            <button class="btn-primary" :disabled="savingId === b.id" @click="saveBrand(b)">
              {{ savingId === b.id ? "Сохранение…" : "Сохранить" }}
            </button>
          </div>
        </div>
        <p v-if="!filteredBrands.length" class="muted">Ничего не найдено.</p>
      </div>
    </section>

    <!-- Item style prompts -->
    <section v-if="auth.isAdmin" class="panel">
      <h2>Промпты Item-стилей</h2>

      <form class="create-brand" @submit.prevent="createItemStyle">
        <div class="field">
          <label class="field__label">Новый Item-стиль</label>
          <input
            v-model="newItemKey"
            class="field__input"
            type="text"
            placeholder="Название стиля (напр. Neon)"
            required
          />
        </div>
        <div class="field">
          <label class="field__label">Промпт стиля</label>
          <textarea
            v-model="newItemContent"
            class="prompt"
            rows="3"
            placeholder="Обёртка стиля; {{prompt}} = текст пользователя (иначе он добавится в конец)"
          />
        </div>
        <div class="create-brand__foot">
          <span v-if="newItemMsg" class="create-brand__msg">{{ newItemMsg }}</span>
          <button type="submit" class="btn-primary" :disabled="creatingItem || !newItemKey.trim()">
            {{ creatingItem ? "Создание…" : "Создать стиль" }}
          </button>
        </div>
      </form>

      <div v-for="p in itemPrompts" :key="p.key" class="item-prompt">
        <div class="brand-card__head">
          <span class="brand-card__name">{{ p.key }}</span>
          <span v-if="itemMsg[p.key]" class="brand-card__msg">{{ itemMsg[p.key] }}</span>
        </div>
        <textarea v-model="p.content" class="prompt" rows="3" />
        <div class="brand-card__foot">
          <button class="btn-primary" @click="saveItemPrompt(p)">Сохранить</button>
        </div>
      </div>
      <p v-if="!itemPrompts.length" class="muted">Стилей нет.</p>
    </section>

    <!-- Tournaments (Phase 4): elements, default prompts, provider refs.
         Visible to ADMIN and MANAGER — the only section MANAGER sees. -->
    <section class="panel">
      <h2>Tournaments</h2>
      <p class="muted small">
        Категории генерации (Tournament, Lotterie, Provider, Calendar…), их
        элементы, дефолтные промпты (Base/VIP) и референсы провайдеров для
        страницы Tournaments. Дефолты видны всем дизайнерам; их локальные
        правки не затрагиваются, но при изменении дефолта у них появится плашка.
      </p>

      <!-- System wrapper -->
      <div class="item-prompt">
        <div class="brand-card__head">
          <span class="brand-card__name">Системная обёртка</span>
          <span class="badge badge--off" v-text="'{{prompt}} = промпт элемента'" />
          <span v-if="tourMsg.system" class="brand-card__msg">{{ tourMsg.system }}</span>
        </div>
        <textarea v-model="tourSystemPrompt" class="prompt" rows="3" />
        <div class="brand-card__foot">
          <button class="btn-primary" @click="saveTourSystemPrompt">Сохранить</button>
        </div>
      </div>

      <!-- New category: Base+VIP toggle or a single fixed mode -->
      <form class="add-form" @submit.prevent="addTourCategory">
        <input v-model="newCatName" type="text" placeholder="Новая категория (напр. Provider 2)…" />
        <select v-model="newCatMode" class="field__input tour-cat__modepick">
          <option value="BOTH">Base + VIP</option>
          <option value="BASE">только Base</option>
          <option value="VIP">только VIP</option>
        </select>
        <button type="submit" class="btn-primary">Создать категорию</button>
        <span v-if="tourMsg.newcat" class="brand-card__msg">{{ tourMsg.newcat }}</span>
      </form>

      <div v-for="cat in tourCategories" :key="cat.id" class="tour-cat">
        <div class="tour-cat__head">
          <input v-model="cat.name" class="field__input tour-cat__name" type="text" />
          <span class="badge badge--off">
            {{ cat.hasModes ? "Base + VIP" : cat.fixedMode === "VIP" ? "только VIP" : "только Base" }}
          </span>
          <span class="badge badge--off" :title="'Папка в ZIP'">{{ cat.key }}</span>
          <button class="btn-primary btn-small" @click="saveTourCategory(cat)">Сохранить</button>
          <button class="btn-danger btn-small" @click="deleteTourCategory(cat)">
            Удалить категорию
          </button>
          <span v-if="tourMsg[cat.id]" class="brand-card__msg">{{ tourMsg[cat.id] }}</span>
        </div>

        <form class="add-form" @submit.prevent="addTourElement(cat)">
          <input
            v-model="newElementName[cat.id]"
            type="text"
            :placeholder="cat.key === 'provider' ? 'Новый провайдер…' : 'Новый элемент…'"
          />
          <button type="submit" class="btn-primary">Добавить</button>
        </form>

        <div class="brand-list">
          <div
            v-for="el in cat.elements"
            :key="el.id"
            :class="['brand-card', { 'tour-el--off': !el.isActive }]"
          >
            <div class="brand-card__head">
              <input v-model="el.name" class="field__input tour-el__name" type="text" />
              <span v-if="!el.isActive" class="badge badge--warn">выключен</span>
              <span v-if="tourMsg[el.id]" class="brand-card__msg">{{ tourMsg[el.id] }}</span>
            </div>

            <!-- Provider refs: the 2 images baked into this provider's generations -->
            <div v-if="cat.key === 'provider'" class="refs refs--two">
              <div v-for="(url, i) in el.referenceImages" :key="i" class="ref">
                <div class="ref__preview">
                  <img v-if="url" :src="url" alt="" />
                  <span v-else class="ref__ph">Ref{{ i + 1 }}</span>
                </div>
                <input
                  v-model="el.referenceImages[i]"
                  class="ref__url"
                  type="text"
                  :placeholder="`Ref${i + 1} URL`"
                />
                <label class="ref__upload">
                  Загрузить
                  <input type="file" accept="image/*" hidden @change="(e) => uploadTourRef(el, i, e)" />
                </label>
              </div>
            </div>

            <!-- Default prompts (one textarea per mode) -->
            <div v-for="p in sortedPrompts(el)" :key="p.mode" class="tour-prompt">
              <div class="tour-prompt__row">
                <span :class="['badge', p.mode === 'VIP' ? 'badge--warn' : 'badge--ok']">
                  {{ cat.hasModes ? p.mode : cat.name }}
                </span>
                <button class="btn-primary btn-small" @click="saveTourPrompt(el, p)">
                  Сохранить промпт
                </button>
              </div>
              <textarea v-model="p.content" class="prompt" rows="3" />
            </div>

            <div class="brand-card__foot">
              <label class="checkbox" title="Выключенный элемент скрыт на странице Tournaments">
                <input type="checkbox" :checked="el.isActive" @change="toggleTourActive(el)" />
                Активен
              </label>
              <button v-if="el.isActive" class="btn-danger" @click="deleteTourElement(el)">
                Удалить
              </button>
              <button class="btn-primary" @click="saveTourElement(cat, el)">Сохранить</button>
            </div>
          </div>
          <p v-if="!cat.elements.length" class="muted">Элементов нет.</p>
        </div>
      </div>
    </section>

    <!-- Smartico brands (Unique-Image-Smartico) -->
    <section v-if="auth.isAdmin" class="panel">
      <h2>Smartico-бренды</h2>
      <p class="muted small">
        Канонический список brand_id для сервиса Unique Image Smartico. По нему
        нормализуются имена папок из ZIP при генерации функции. Если имя бренда из
        архива не найдено здесь — он всё равно попадёт в функцию, но будет
        подсвечен как «перепроверьте».
      </p>

      <form class="add-form" @submit.prevent="addSmarticoBrand">
        <input v-model="newSmarticoName" type="text" placeholder="Напр. BrunoCasino" required />
        <button type="submit" class="btn-primary">Добавить</button>
        <span v-if="smarticoMsg" class="create-brand__msg">{{ smarticoMsg }}</span>
      </form>

      <input
        v-model="smarticoSearch"
        class="search"
        type="text"
        placeholder="Поиск бренда…"
      />
      <p class="muted small">Всего: {{ smarticoBrands.length }}</p>

      <table class="table">
        <thead>
          <tr><th>Brand ID</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="b in filteredSmarticoBrands" :key="b.id">
            <td>
              <template v-if="editingId === b.id">
                <input
                  v-model="editingName"
                  class="field__input"
                  type="text"
                  @keyup.enter="saveSmarticoBrand(b)"
                  @keyup.esc="cancelEditSmarticoBrand"
                />
              </template>
              <template v-else>{{ b.name }}</template>
            </td>
            <td class="smartico-actions">
              <template v-if="editingId === b.id">
                <button class="btn-primary" @click="saveSmarticoBrand(b)">Сохранить</button>
                <button class="btn-toggle" @click="cancelEditSmarticoBrand">Отмена</button>
              </template>
              <template v-else>
                <button class="btn-toggle" @click="startEditSmarticoBrand(b)">Переименовать</button>
                <button class="btn-danger" @click="removeSmarticoBrand(b)">Удалить</button>
              </template>
            </td>
          </tr>
          <tr v-if="!filteredSmarticoBrands.length">
            <td colspan="2" class="muted">Ничего не найдено.</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style scoped>
.admin {
  display: flex;
  flex-direction: column;
  gap: var(--space-20);
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}
h1 {
  margin: 0;
}
.panel {
  background: var(--color-window);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-32);
}
h2 {
  margin: 0 0 16px;
  font-size: 16px;
}
.add-form {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.add-form input {
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-white);
}
.add-form input[type="email"] {
  flex: 1;
  min-width: 220px;
}
.table {
  width: 100%;
  border-collapse: collapse;
}
.table th,
.table td {
  text-align: left;
  padding: 10px 8px;
  border-bottom: 1px solid var(--color-border);
  font-size: 14px;
}
.table th {
  color: var(--color-grey);
  font-weight: 600;
}
.muted {
  color: var(--color-grey);
}
.error {
  background: rgba(244, 115, 115, 0.12);
  color: var(--color-stop-hover);
  border: 1px solid var(--color-stop);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
}
.btn-primary {
  background: var(--gradient-active);
  color: var(--color-white);
  border: none;
  border-radius: var(--radius-sm);
  padding: 8px 16px;
  font-weight: 600;
}
.btn-danger {
  background: var(--color-stop);
  color: var(--color-white);
  border: none;
  border-radius: var(--radius-sm);
  padding: 6px 12px;
}
.btn-danger:hover {
  background: var(--color-stop-hover);
}
.btn-toggle {
  border: 1px solid var(--color-border);
  background: var(--color-white);
  border-radius: var(--radius-sm);
  padding: 6px 14px;
}
select {
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-white);
}

/* ---- catalog management ---- */
.small {
  font-size: 13px;
  margin: 0 0 12px;
}
.search {
  width: 100%;
  max-width: 360px;
  padding: 8px 14px;
  margin-bottom: 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-white);
}
.brand-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.brand-card,
.item-prompt {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-white);
  padding: 16px;
}
.brand-card__head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.brand-card__name {
  font-weight: 600;
}
.brand-card__msg {
  margin-left: auto;
  font-size: 13px;
  color: var(--color-accent);
}
.badges {
  display: inline-flex;
  gap: 6px;
}
.badge {
  font-size: 11px;
  padding: 2px 9px;
  border-radius: var(--radius-pill);
  white-space: nowrap;
}
.badge--ok {
  background: rgba(138, 56, 245, 0.12);
  color: var(--color-accent);
}
.badge--warn {
  background: rgba(244, 175, 64, 0.16);
  color: #b9791b;
}
.badge--off {
  background: var(--color-bubble);
  color: var(--color-grey);
}
.brand-filters {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.brand-filters .search {
  margin-bottom: 0;
}
.checkbox {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--color-text);
  cursor: pointer;
}
.model-select {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--color-text);
}
.model-select select {
  font-size: 14px;
  padding: 4px 8px;
  border-radius: 6px;
}
.refs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 12px;
}
.ref {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ref__preview {
  display: grid;
  place-items: center;
  aspect-ratio: 1;
  border-radius: var(--radius-sm);
  background: var(--color-bubble);
  overflow: hidden;
}
.ref__preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ref__ph {
  color: var(--color-grey);
  font-size: 13px;
}
.ref__url {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-white);
  font-size: 12px;
}
.ref__upload {
  text-align: center;
  padding: 6px 10px;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--color-grey);
  cursor: pointer;
}
.ref__upload:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
}
.prompt {
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
}
.brand-card__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 18px;
  margin-top: 12px;
}
.item-prompt {
  margin-bottom: 12px;
}
.item-prompt .prompt {
  margin-top: 4px;
}

/* ---- create brand ---- */
.create-brand {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 640px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field__label {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
}
.field__input {
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-white);
  font-family: inherit;
  font-size: 14px;
  color: var(--color-text);
}
.cat-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.cat-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-white);
  font-size: 13px;
  color: var(--color-text);
  cursor: pointer;
}
.create-brand__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 14px;
}
.create-brand__msg {
  font-size: 13px;
  color: var(--color-accent);
}
.smartico-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

/* ---- tournaments ---- */
.tour-cat {
  margin-top: 24px;
}
.tour-cat__head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.tour-cat__name {
  max-width: 260px;
  font-weight: 700;
  font-size: 15px;
}
.tour-cat__modepick {
  max-width: 160px;
}
.tour-cat__head .btn-small {
  margin-left: 0;
}
.tour-cat__head .btn-small:first-of-type {
  margin-left: auto;
}
.tour-el--off {
  opacity: 0.55;
}
.tour-el__name {
  max-width: 320px;
  font-weight: 600;
}
.refs--two {
  grid-template-columns: repeat(2, minmax(0, 220px));
}
.tour-prompt {
  margin-bottom: 12px;
}
.tour-prompt__row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}
.btn-small {
  padding: 4px 12px;
  font-size: 12px;
  margin-left: auto;
}
</style>
