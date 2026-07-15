<script setup lang="ts">
import { watch, onBeforeUnmount } from "vue";
import { confidenceLevel, type TextWarning } from "~/composables/useImageTextScanner";

/**
 * Поп-ап текст-скана (TASK Трек A): «на этих картинках обнаружен текст».
 * Неблокирующий — закрытие = «игнорировать», предупреждения остаются в баннере
 * хоста (CrmSmartico). Действия по картинке: «Пометить ок» (глобальный
 * whitelist) и «Перейти к замене» (Drive-поток, открывает папку бренда).
 */

const props = defineProps<{
  open: boolean;
  warnings: TextWarning[];
  pending: Set<string>;
  error: string;
}>();

const emit = defineEmits<{
  close: [];
  "mark-ok": [md5: string];
}>();

const CONFIDENCE_LABEL: Record<ReturnType<typeof confidenceLevel>, string> = {
  high: "высокая",
  medium: "средняя",
  low: "низкая",
};

function driveFolderUrl(id: string): string {
  return `https://drive.google.com/drive/folders/${id}`;
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}
watch(
  () => props.open,
  (o) => {
    if (!import.meta.client) return;
    if (o) window.addEventListener("keydown", onKey);
    else window.removeEventListener("keydown", onKey);
    document.body.style.overflow = o ? "hidden" : "";
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (!import.meta.client) return;
  window.removeEventListener("keydown", onKey);
  if (props.open) document.body.style.overflow = "";
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="tw-overlay" @click.self="emit('close')">
      <div class="tw-panel" role="dialog" aria-modal="true" aria-label="Обнаружен текст на картинках">
        <div class="tw-head">
          <div class="tw-title">⚠️ Обрати внимание — на этих картинках обнаружен текст</div>
          <button class="tw-close" type="button" aria-label="Закрыть" @click="emit('close')">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
          </button>
        </div>

        <p class="tw-hint">
          Эталон для блока Email — картинка без вшитого текста. Проверьте список:
          «Пометить ок» уберёт предупреждение навсегда (для этой картинки),
          закрытие окна — просто игнорирует.
        </p>

        <p v-if="error" class="tw-error">{{ error }}</p>

        <div class="tw-list">
          <div v-for="w in warnings" :key="w.md5" class="tw-card">
            <a class="tw-preview" :href="w.url" target="_blank" rel="noopener">
              <img :src="w.url" :alt="w.publicId" loading="lazy" />
            </a>
            <div class="tw-info">
              <div class="tw-brand">{{ w.brand }}</div>
              <code class="tw-pid">{{ w.publicId }}</code>
              <div class="tw-text">«{{ w.text }}»</div>
              <div class="tw-conf" :class="`tw-conf--${confidenceLevel(w.confidence)}`">
                Уверенность: {{ CONFIDENCE_LABEL[confidenceLevel(w.confidence)] }}
              </div>
              <div class="tw-actions">
                <button
                  class="tw-btn tw-btn--ok"
                  type="button"
                  :disabled="pending.has(w.md5)"
                  @click="emit('mark-ok', w.md5)"
                >
                  {{ pending.has(w.md5) ? "…" : "Пометить ок" }}
                </button>
                <a
                  v-if="w.driveFolderId"
                  class="tw-btn tw-btn--replace"
                  :href="driveFolderUrl(w.driveFolderId)"
                  target="_blank"
                  rel="noopener"
                >Перейти к замене ↗</a>
              </div>
            </div>
          </div>
        </div>

        <div class="tw-foot">
          <button class="tw-btn tw-btn--ghost" type="button" @click="emit('close')">
            Игнорировать
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.tw-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(20, 22, 30, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.tw-panel {
  background: var(--color-white);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  width: min(720px, 100%);
  max-height: min(84vh, 900px);
  display: flex;
  flex-direction: column;
  padding: 20px 22px;
  gap: 12px;
}
.tw-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.tw-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--color-text);
  line-height: 1.35;
}
.tw-close {
  margin-left: auto;
  flex: 0 0 auto;
  border: none;
  background: transparent;
  color: var(--color-grey);
  cursor: pointer;
  padding: 2px;
}
.tw-close:hover {
  color: var(--color-text);
}
.tw-hint {
  margin: 0;
  font-size: 13px;
  color: var(--color-grey);
  line-height: 1.5;
}
.tw-error {
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  background: rgba(244, 115, 115, 0.12);
  color: var(--color-stop-hover);
  border: 1px solid var(--color-stop);
}
.tw-list {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}
.tw-card {
  display: flex;
  gap: 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 12px;
  background: var(--color-bg);
}
.tw-preview {
  flex: 0 0 auto;
}
.tw-preview img {
  width: 110px;
  height: 110px;
  object-fit: contain;
  border-radius: var(--radius-sm);
  background:
    repeating-conic-gradient(#e8e8ee 0% 25%, #f7f7fa 0% 50%) 0 0 / 16px 16px;
  border: 1px solid var(--color-border);
  display: block;
}
.tw-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.tw-brand {
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text);
}
.tw-pid {
  font-size: 11.5px;
  color: var(--color-grey);
  word-break: break-all;
}
.tw-text {
  font-size: 13px;
  color: var(--color-text);
  line-height: 1.4;
  word-break: break-word;
}
.tw-conf {
  font-size: 12px;
  font-weight: 600;
}
.tw-conf--high {
  color: var(--color-stop-hover);
}
.tw-conf--medium {
  color: #b9791b;
}
.tw-conf--low {
  color: var(--color-grey);
}
.tw-actions {
  margin-top: 4px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.tw-btn {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  background: var(--color-white);
  color: var(--color-text);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
}
.tw-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.tw-btn--ok:hover:not(:disabled) {
  border-color: #48bb78;
  background: rgba(72, 187, 120, 0.12);
  color: #276749;
}
.tw-btn--replace:hover {
  border-color: var(--color-accent);
  background: var(--color-bubble);
}
.tw-btn--ghost {
  color: var(--color-grey);
}
.tw-btn--ghost:hover {
  color: var(--color-text);
  border-color: var(--color-grey);
}
.tw-foot {
  display: flex;
  justify-content: flex-end;
  padding-top: 4px;
  border-top: 1px solid var(--color-border);
}

@media (max-width: 600px) {
  .tw-card {
    flex-direction: column;
  }
  .tw-preview img {
    width: 100%;
    height: 140px;
  }
}
</style>
