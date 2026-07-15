import { ref, computed } from "vue";

/**
 * Текст-скан email-картинок (TASK Трек A, фронт). Бэкенд уже вернул готовые
 * предупреждения внутри результата джобы (`result.textWarnings`) — здесь только
 * состояние поп-апа/баннера и «пометить ок» (глобальный whitelist по MD5).
 *
 * `api` передаётся снаружи (обычно `useApi()`), чтобы composable можно было
 * тестировать без Nuxt-контекста.
 */

export interface TextWarning {
  brand: string;
  publicId: string;
  url: string;
  md5: string; // ключ whitelist для «пометить ок»
  text: string; // что модель прочитала на картинке
  confidence: number; // 0..1
  driveFolderId: string | null; // Drive-поток: цель «перейти к замене»
}

export type ConfidenceLevel = "high" | "medium" | "low";

// UI показывает грубый бейдж, а не сырое число (решение интервью).
const CONFIDENCE_HIGH_MIN = 0.8;
const CONFIDENCE_MEDIUM_MIN = 0.5;

export function confidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= CONFIDENCE_HIGH_MIN) return "high";
  if (confidence >= CONFIDENCE_MEDIUM_MIN) return "medium";
  return "low";
}

type WhitelistApi = (
  url: string,
  opts: { method: "POST"; body: { md5: string } },
) => Promise<unknown>;

export function useImageTextScanner(api: WhitelistApi) {
  const warnings = ref<TextWarning[]>([]);
  const popupOpen = ref(false);
  // md5, помеченные «ок» в этой сессии — прячем сразу, не дожидаясь перегенерации.
  const approved = ref(new Set<string>());
  const pending = ref(new Set<string>()); // защита от даблклика по «Пометить ок»
  const markError = ref("");

  const activeWarnings = computed(() =>
    warnings.value.filter((w) => !approved.value.has(w.md5)),
  );
  const hasWarnings = computed(() => activeWarnings.value.length > 0);

  /** Вызывается при завершении джобы: непустой список сразу открывает поп-ап. */
  function setWarnings(list: TextWarning[]) {
    warnings.value = list;
    approved.value = new Set();
    pending.value = new Set();
    markError.value = "";
    popupOpen.value = list.length > 0;
  }

  function openPopup() {
    if (hasWarnings.value) popupOpen.value = true;
  }

  /** «Игнорировать»: закрыть поп-ап, предупреждения остаются в баннере. */
  function closePopup() {
    popupOpen.value = false;
  }

  /** «Пометить ок»: глобальный whitelist. Ошибка не роняет список — можно повторить. */
  async function markOk(md5: string) {
    if (pending.value.has(md5) || approved.value.has(md5)) return;
    markError.value = "";
    pending.value.add(md5);
    try {
      await api("/api/smartico/text-whitelist", { method: "POST", body: { md5 } });
      approved.value.add(md5);
      if (!hasWarnings.value) popupOpen.value = false; // помечено всё — закрываемся
    } catch {
      markError.value = "Не удалось пометить картинку. Попробуйте ещё раз.";
    } finally {
      pending.value.delete(md5);
    }
  }

  function reset() {
    warnings.value = [];
    approved.value = new Set();
    pending.value = new Set();
    markError.value = "";
    popupOpen.value = false;
  }

  return {
    activeWarnings,
    hasWarnings,
    popupOpen,
    pending,
    markError,
    setWarnings,
    openPopup,
    closePopup,
    markOk,
    reset,
  };
}
