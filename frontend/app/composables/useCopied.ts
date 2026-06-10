/**
 * Tiny "copied!" feedback state for copy-to-clipboard buttons: markCopied(key)
 * flips `copiedKey` to that key for a moment (icon → checkmark in the UI),
 * then clears it. One instance per page; keys are image ids or sentinel
 * strings like "selected" for bulk-copy buttons.
 */
export function useCopied(timeoutMs = 1500) {
  const copiedKey = ref<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function markCopied(key: string) {
    copiedKey.value = key;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      copiedKey.value = null;
    }, timeoutMs);
  }

  onUnmounted(() => {
    if (timer) clearTimeout(timer);
  });

  return { copiedKey, markCopied };
}
