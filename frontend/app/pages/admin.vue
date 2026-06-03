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
  role: "ADMIN" | "DESIGNER";
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

const brands = ref<AdminBrand[]>([]);
const categories = ref<BrandCategory[]>([]);
const itemPrompts = ref<ItemPrompt[]>([]);

// ---- Create brand (TASK §2) ----
function emptyNewBrand() {
  return {
    name: "",
    categoryIds: [] as string[],
    personPrompt: "",
    stylePrompt: "",
    referenceImages: ["", "", ""], // 3 ref slots (Cloudinary URLs)
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
    const res = await api<{ brands: AdminBrand[]; categories: BrandCategory[]; itemPrompts: ItemPrompt[] }>(
      "/api/admin/catalog",
    );
    brands.value = res.brands.map((b) => ({ ...b, referenceImages: padTo3(b.referenceImages) }));
    categories.value = res.categories;
    itemPrompts.value = res.itemPrompts;
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

onMounted(() => {
  void load();
  void loadCatalog();
});
</script>

<template>
  <div class="admin">
    <h1>Администрирование</h1>
    <p v-if="error" class="error">{{ error }}</p>

    <section class="panel">
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

    <section class="panel">
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
                @change="patchUser(u, { role: ($event.target as HTMLSelectElement).value as 'ADMIN' | 'DESIGNER' })"
              >
                <option value="DESIGNER">DESIGNER</option>
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
    <section class="panel">
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
    <section class="panel">
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
            <button class="btn-primary" :disabled="savingId === b.id" @click="saveBrand(b)">
              {{ savingId === b.id ? "Сохранение…" : "Сохранить" }}
            </button>
          </div>
        </div>
        <p v-if="!filteredBrands.length" class="muted">Ничего не найдено.</p>
      </div>
    </section>

    <!-- Item style prompts -->
    <section class="panel">
      <h2>Промпты Item-стилей</h2>
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
  </div>
</template>

<style scoped>
.admin {
  display: flex;
  flex-direction: column;
  gap: 24px;
}
h1 {
  margin: 0;
}
.panel {
  background: var(--color-window);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 24px;
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
  justify-content: flex-end;
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
</style>
