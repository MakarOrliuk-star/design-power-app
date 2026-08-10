import { describe, it, expect } from "vitest";
import { missingRefFormatsFor, worstRefCount, effectiveRefCount } from "~/utils/refGating";
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

// Тон-варианты (DI2-10): персонажа задают референсы, поэтому у (Men)/(Women)
// могут быть свои пулы; пустой пул наследует общий пул бренда.
describe("тон-варианты", () => {
  const VARIANTS = [
    { name: "Betnella(Men)", displayName: "Betnella (Men)" },
    { name: "Betnella(Women)", displayName: "Betnella (Women)" },
  ];
  const toneCounts: RefCountsMap = {
    Betnella: { email: 8, popup: 6, push: 7 }, // общий пул
    "Betnella(Men)": { email: 6, popup: 5, push: 5 }, // свой полный
    "Betnella(Women)": { email: 6, popup: 2 }, // начат и не добран
  };

  it("свой пул перебивает общий, пустой — наследует общий", () => {
    expect(effectiveRefCount(toneCounts, "Betnella", "Betnella(Men)", "email")).toBe(6);
    // push у Women не заводили вовсе → берётся общий пул бренда (7).
    expect(effectiveRefCount(toneCounts, "Betnella", "Betnella(Women)", "push")).toBe(7);
  });

  it("начатый, но недобранный пул тона НЕ подменяется общим — это явная ошибка", () => {
    // popup у Women = 2 своих, хотя в общем 6: молча смешивать полы нельзя.
    expect(effectiveRefCount(toneCounts, "Betnella", "Betnella(Women)", "popup")).toBe(2);
    expect(missingRefFormatsFor(toneCounts, FORMATS, MIN, "Betnella", VARIANTS)).toEqual([
      { label: "Women · Pop-up", count: 2 },
    ]);
  });

  it("бейдж бренда падает до худшего тона", () => {
    expect(worstRefCount(toneCounts, FORMATS, "Betnella", VARIANTS)).toBe(2);
  });

  it("общий пул закрывает оба тона, если своих нет", () => {
    const onlyBase: RefCountsMap = { Betnella: { email: 8, popup: 6, push: 7 } };
    expect(missingRefFormatsFor(onlyBase, FORMATS, MIN, "Betnella", VARIANTS)).toEqual([]);
  });
});
