import { ref, computed, type Ref } from "vue";

/**
 * Undo/redo for the ScalePanel mask brush (TASK Трек B). Granularity: ONE
 * stroke (pointerdown → pointerup) = one action; "Очистить маску" is one
 * undoable action too. Strokes are vector paths (source-px point arrays), so
 * the history is kilobytes — no depth cap within an editor session.
 *
 * The composable OWNS mutations it records: the host pushes a stroke while
 * drawing and calls `commitStroke` on pointerup; `commitClear` both empties
 * the mask and records the snapshot. A stroke is never mutated after commit
 * (only the in-progress last stroke grows), so actions can hold references.
 */

export interface MaskStroke {
  points: number[]; // SOURCE-image px, [x0, y0, x1, y1, ...]
  size: number; // brush diameter in SOURCE px
}

type MaskAction =
  | { kind: "add"; stroke: MaskStroke }
  | { kind: "clear"; snapshot: MaskStroke[] };

export function useMaskHistory(strokes: Ref<MaskStroke[]>) {
  const past = ref<MaskAction[]>([]);
  const undone = ref<MaskAction[]>([]);

  const canUndo = computed(() => past.value.length > 0);
  const canRedo = computed(() => undone.value.length > 0);

  /** Record the just-finished stroke (the last element of `strokes`). */
  function commitStroke() {
    const stroke = strokes.value[strokes.value.length - 1];
    if (!stroke) return;
    past.value = [...past.value, { kind: "add", stroke }];
    undone.value = []; // любое новое действие обнуляет redo
  }

  /** Empty the mask as ONE undoable action (no-op on an already empty mask). */
  function commitClear() {
    if (!strokes.value.length) return;
    past.value = [...past.value, { kind: "clear", snapshot: strokes.value }];
    undone.value = [];
    strokes.value = [];
  }

  function undo() {
    const action = past.value[past.value.length - 1];
    if (!action) return;
    past.value = past.value.slice(0, -1);
    if (action.kind === "add") strokes.value = strokes.value.slice(0, -1);
    else strokes.value = [...action.snapshot];
    undone.value = [...undone.value, action];
  }

  function redo() {
    const action = undone.value[undone.value.length - 1];
    if (!action) return;
    undone.value = undone.value.slice(0, -1);
    if (action.kind === "add") strokes.value = [...strokes.value, action.stroke];
    else strokes.value = [];
    past.value = [...past.value, action];
  }

  /** Hard reset — new image / tool switch / editor close (strokes are the host's). */
  function reset() {
    past.value = [];
    undone.value = [];
  }

  return { commitStroke, commitClear, undo, redo, reset, canUndo, canRedo };
}
