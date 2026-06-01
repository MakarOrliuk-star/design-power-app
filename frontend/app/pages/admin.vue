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

onMounted(load);
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
</style>
