import { describe, it, expect } from "vitest";
import { ref } from "vue";
import { useMaskHistory, type MaskStroke } from "~/composables/useMaskHistory";

/**
 * FE Test — mask undo/redo (TASK Трек B). Granularity: one stroke = one
 * action; "Очистить маску" is one undoable action; redo dies on a new action.
 */

function stroke(n: number): MaskStroke {
  return { points: [n, n, n + 1, n + 1], size: 40 };
}

/** Simulate pointerdown→up: the host pushes the stroke, then commits. */
function draw(strokes: ReturnType<typeof ref<MaskStroke[]>>, h: { commitStroke(): void }, n: number) {
  strokes.value = [...strokes.value!, stroke(n)];
  h.commitStroke();
}

function setup() {
  const strokes = ref<MaskStroke[]>([]);
  const history = useMaskHistory(strokes);
  return { strokes, history };
}

describe("useMaskHistory", () => {
  it("undo removes exactly one stroke per press; redo puts them back in order", () => {
    const { strokes, history } = setup();
    draw(strokes, history, 1);
    draw(strokes, history, 2);
    draw(strokes, history, 3);

    history.undo();
    expect(strokes.value).toEqual([stroke(1), stroke(2)]);
    history.undo();
    expect(strokes.value).toEqual([stroke(1)]);

    history.redo();
    expect(strokes.value).toEqual([stroke(1), stroke(2)]);
    history.redo();
    expect(strokes.value).toEqual([stroke(1), stroke(2), stroke(3)]);
    expect(history.canRedo.value).toBe(false);
  });

  it("clear is ONE undoable action restoring the exact strokes; redo clears again", () => {
    const { strokes, history } = setup();
    draw(strokes, history, 1);
    draw(strokes, history, 2);

    history.commitClear();
    expect(strokes.value).toEqual([]);

    history.undo(); // один Ctrl+Z возвращает ВСЮ стёртую маску
    expect(strokes.value).toEqual([stroke(1), stroke(2)]);

    history.redo();
    expect(strokes.value).toEqual([]);
  });

  it("a new stroke after undo kills the redo branch", () => {
    const { strokes, history } = setup();
    draw(strokes, history, 1);
    draw(strokes, history, 2);
    history.undo();
    expect(history.canRedo.value).toBe(true);

    draw(strokes, history, 9);
    expect(history.canRedo.value).toBe(false);
    expect(strokes.value).toEqual([stroke(1), stroke(9)]);
    // Undo still walks the new timeline.
    history.undo();
    expect(strokes.value).toEqual([stroke(1)]);
  });

  it("no-ops: undo/redo on empty stacks, clear on an empty mask, commit with no stroke", () => {
    const { strokes, history } = setup();
    history.undo();
    history.redo();
    history.commitClear();
    history.commitStroke();
    expect(strokes.value).toEqual([]);
    expect(history.canUndo.value).toBe(false);
    expect(history.canRedo.value).toBe(false);
  });

  it("reset drops both stacks without touching the strokes (host owns them)", () => {
    const { strokes, history } = setup();
    draw(strokes, history, 1);
    history.undo();
    history.reset();
    expect(history.canUndo.value).toBe(false);
    expect(history.canRedo.value).toBe(false);
    expect(strokes.value).toEqual([]); // undo уже убрал мазок; reset ничего не менял
  });
});
