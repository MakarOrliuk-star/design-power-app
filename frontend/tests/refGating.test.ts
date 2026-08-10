import { describe, it, expect } from "vitest";
import { missingRefFormatsFor, worstRefCount } from "~/utils/refGating";
import type { RefCountsMap, RefFormatMeta } from "~/utils/refGating";

// Гейт брендов в мастере (TASK multiformat-promo, DI2-2): у email, push и
// pop-up раздельные пулы референсов, фолбэка между ними нет — бренд идёт в
// генерацию, только если КАЖДЫЙ формат набрал минимум.
const FORMATS: RefFormatMeta[] = [
  { key: "email", label: "Email", isAnchor: true },
  { key: "popup", label: "Pop-up" },
  { key: "push", label: "Push" },
];
const MIN = 5;

const counts: RefCountsMap = {
  Betnella: { email: 8, popup: 6, push: 5 }, // готов
  Corgi: { email: 9, popup: 2 }, // pop-up мало, push вообще нет
  Ghost: {}, // ничего не загружено
};

describe("missingRefFormatsFor", () => {
  it("полный набор по всем форматам → бренд не заблокирован", () => {
    expect(missingRefFormatsFor(counts, FORMATS, MIN, "Betnella")).toEqual([]);
  });

  it("перечисляет именно недобравшие форматы (в т.ч. полностью пустые)", () => {
    expect(missingRefFormatsFor(counts, FORMATS, MIN, "Corgi")).toEqual([
      { label: "Pop-up", count: 2 },
      { label: "Push", count: 0 },
    ]);
  });

  it("бренда нет в счётчиках → все форматы по нулям", () => {
    expect(missingRefFormatsFor(counts, FORMATS, MIN, "Ghost")).toEqual([
      { label: "Email", count: 0 },
      { label: "Pop-up", count: 0 },
      { label: "Push", count: 0 },
    ]);
  });

  it("режим ai_reference нигде не включён → блокировать нечего", () => {
    expect(missingRefFormatsFor(counts, [], MIN, "Ghost")).toEqual([]);
  });
});

describe("worstRefCount", () => {
  it("бейдж показывает худший формат, а не сумму", () => {
    expect(worstRefCount(counts, FORMATS, "Betnella")).toBe(5);
    expect(worstRefCount(counts, FORMATS, "Corgi")).toBe(0);
    expect(worstRefCount(counts, [], "Betnella")).toBe(0);
  });
});
