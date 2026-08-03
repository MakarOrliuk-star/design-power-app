import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  aggregate,
  applyTolerance,
  checkAgainstSpec,
  measure,
  renderOnCheckerboard,
  type Metrics,
  type PatternSpec,
} from "../src/lib/patternMiner.js";
import { mineCorpus } from "../scripts/mine-pattern.js";

/**
 * Приёмка Фазы 1 (TASK §8, DoD): паттерн — выход кода, а не константы; один и
 * тот же майнер меряет эталон и наш результат; повторный прогон побайтово
 * идентичен; валидатор пропускает все пять эталонов и бракует `result-2`.
 *
 * Числа-ожидания взяты из таблицы TASK §3.2 — это внешний контракт, а не наш
 * собственный вывод, поэтому тест ловит регресс методики, а не переписывает её.
 */

const EXAMPLES = path.resolve(__dirname, "../../figma/crm-bundle/examples");
const REFERENCES = ["1.jfif", "2.jfif", "3.jfif", "4.jfif", "5.jfif"];

let spec: PatternSpec;
let refMetrics: Map<string, Metrics>;

beforeAll(async () => {
  const mined = await mineCorpus(EXAMPLES);
  spec = mined.spec;
  refMetrics = new Map(mined.samples.map((s) => [s.name, s.metrics]));
}, 120_000);

describe("методика §3.1 воспроизводит таблицу §3.2", () => {
  // Строки, совпадающие с эталонной таблицей точно (целые счётчики).
  const EXACT: Array<[keyof Metrics, number[]]> = [
    ["componentCount", [14, 19, 9, 17, 17]],
    ["decorCount", [12, 17, 7, 15, 15]],
    ["croppedTop", [1, 2, 2, 1, 2]],
    ["croppedLeft", [1, 3, 1, 0, 0]],
    ["croppedRight", [1, 2, 2, 1, 1]],
    ["croppedBottom", [0, 0, 0, 0, 0]],
  ];

  for (const [key, expected] of EXACT) {
    it(`${key} совпадает точно`, () => {
      const got = REFERENCES.map((n) => refMetrics.get(n)![key]);
      expect(got).toEqual(expected);
    });
  }

  // Непрерывные величины — с допуском на реализацию (§3.1 не задаёт всех
  // деталей; расхождения разобраны в R-PLAN §1.1).
  const CLOSE: Array<[keyof Metrics, number[], number]> = [
    ["bandCoverage", [8.97, 6.72, 10.09, 5.44, 7.59], 0.1],
    ["bandTopThird", [18.37, 11.26, 18.09, 10.08, 12.45], 0.15],
    ["bandMidThird", [1.04, 2.43, 1.18, 0.17, 0.18], 0.15],
    ["bandBottomThird", [7.55, 6.5, 11.05, 6.09, 10.17], 0.15],
    ["decorAreaPct", [8.06, 6.68, 9.05, 4.43, 6.0], 0.15],
    ["contentBottomPct", [91.8, 92.2, 92.0, 90.6, 91.8], 0.1],
    ["itemClusterHeightPct", [84.6, 85.0, 90.2, 84.8, 91.0], 0.1],
    ["personClusterHeightPct", [90.0, 90.6, 92.0, 88.7, 77.7], 0.1],
    ["personTopPct", [0, 0, 0, 0, 11.1], 0.1],
    ["cornerLum", [3.7, 6.5, 6.7, 2.0, 2.9], 0.5],
    ["centerBgLum", [17.7, 37.6, 17.8, 20.7, 17.8], 1.9],
  ];

  for (const [key, expected, tol] of CLOSE) {
    it(`${key} воспроизводится в пределах ±${tol}`, () => {
      REFERENCES.forEach((n, i) => {
        const got = refMetrics.get(n)![key];
        expect(
          Math.abs(got - expected[i]!),
          `${key} у ${n}: получено ${got}, TASK §3.2 ожидает ${expected[i]}`,
        ).toBeLessThanOrEqual(tol);
      });
    });
  }

  it("прозрачных пикселей у эталонов ровно 0, у result-2 — около 78 %", async () => {
    for (const n of REFERENCES) expect(refMetrics.get(n)!.transparentPct).toBe(0);
    const { metrics } = await measure(await readFile(path.join(EXAMPLES, "result-2.png")));
    expect(metrics.transparentPct).toBeGreaterThan(75);
  }, 30_000);
});

describe("допуск §4.1", () => {
  it("двусторонний коридор расширяется на 10 % ширины", () => {
    const { lo, hi } = applyTolerance(10, 20, "band");
    expect(lo).toBe(9);
    expect(hi).toBe(21);
  });

  it("не меньше 5 % от границы, когда коридор узкий", () => {
    const { lo, hi } = applyTolerance(100, 100, "band");
    expect(lo).toBe(95);
    expect(hi).toBe(105);
  });

  it("коридор из нулей остаётся строгим", () => {
    const { lo, hi } = applyTolerance(0, 0, "band");
    expect(lo).toBe(0);
    expect(hi).toBe(0);
  });

  it("односторонняя проверка не использует ширину коридора", () => {
    // Ширина 175 дала бы допуск 17.5 и увела нижнюю границу в минус —
    // проверка перестала бы срабатывать снизу вообще (см. DIRECTIONS).
    const { lo, hi } = applyTolerance(13.02, 188.18, "floor");
    expect(lo).toBeCloseTo(12.37, 2);
    expect(hi).toBeNull();
  });
});

describe("валидатор = майнер + коридоры (D-C2)", () => {
  it("пропускает ВСЕ пять эталонов без единого ложного срабатывания", () => {
    for (const name of REFERENCES) {
      const report = checkAgainstSpec(refMetrics.get(name)!, spec);
      // Пустой отчёт тоже дал бы failedKeys = [] — убеждаемся, что проверки
      // реально выполнялись, а не молча выключились.
      expect(report.checks.length).toBeGreaterThanOrEqual(20);
      expect(report.failedKeys, `${name} провалил: ${report.failedKeys.join(", ")}`).toEqual([]);
      expect(report.passed).toBe(true);
    }
  });

  it("бракует result-2 по обязательному набору §8 Фазы 5", async () => {
    const { metrics } = await measure(await readFile(path.join(EXAMPLES, "result-2.png")));
    const report = checkAgainstSpec(metrics, spec);

    // Соответствие V-номерам TASK: V2 прозрачность, V3 яркость фона,
    // V4 scene-top, V5 scene-bottom, V7 декор, V8 глубина, V9 подрезка верхом,
    // V11 высота item.
    const MUST_FAIL: Array<keyof Metrics> = [
      "transparentPct",
      "centerBgLum",
      "bandTopThird",
      "bandBottomThird",
      "decorCount",
      "decorAreaPct",
      "sharpnessSpread",
      "croppedTop",
      "itemClusterHeightPct",
    ];
    for (const key of MUST_FAIL) {
      expect(report.failedKeys, `ожидался провал по ${key}`).toContain(key);
    }
    expect(report.failedKeys.length).toBeGreaterThanOrEqual(13);
  }, 30_000);

  it("сверочная метрика max/min в приёмке не участвует", () => {
    const report = checkAgainstSpec(refMetrics.get("1.jfif")!, spec);
    expect(report.checks.map((c) => c.key)).not.toContain("sharpnessSpreadMaxMin");
  });
});

describe("спека — воспроизводимый артефакт (D-C1)", () => {
  it("повторный прогон по тому же корпусу даёт побайтово тот же JSON", async () => {
    const again = await mineCorpus(EXAMPLES);
    expect(JSON.stringify(again.spec)).toBe(JSON.stringify(spec));
  }, 120_000);

  it("в спеке нет даты — иначе побайтовое совпадение недостижимо", () => {
    expect(JSON.stringify(spec)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("коридор несёт вклад каждого эталона и пометку выбросов", () => {
    const c = spec.corridors.centerBgLum!;
    expect(Object.keys(c.values).sort()).toEqual([...REFERENCES].sort());
    // TASK §4.1 приводит ровно этот пример: ex2 c яркостью фона заметно выше
    // остальных обязан быть виден как выброс, а не растворяться в коридоре.
    expect(c.outliers).toContain("2.jfif");
  });

  it("добавление файла в корпус меняет спеку без правки кода", () => {
    const samples = REFERENCES.map((n) => ({
      name: n,
      hash: n,
      metrics: refMetrics.get(n)!,
    }));
    const base = aggregate("t", samples);
    const widened = aggregate("t", [
      ...samples,
      // шестая работа с заметно более плотным декором
      { name: "6.png", hash: "6", metrics: { ...refMetrics.get("1.jfif")!, decorCount: 25 } },
    ]);
    expect(widened.corridors.decorCount!.max).toBe(25);
    expect(widened.corridors.decorCount!.max).toBeGreaterThan(base.corridors.decorCount!.max);
    expect(widened.corpusHash).not.toBe(base.corpusHash);
  });
});

describe("шахматка под прозрачностью", () => {
  it("прозрачные области получают клетчатую подложку, непрозрачные не тронуты", async () => {
    const src = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: {
            create: {
              width: 16,
              height: 16,
              channels: 4,
              background: { r: 255, g: 0, b: 0, alpha: 1 },
            },
          },
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();

    const out = await renderOnCheckerboard(src, 16);
    const { data, info } = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => {
      const i = (y * info.width + x) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    };

    // Непрозрачный красный квадрат остался красным.
    expect(at(8, 8)).toEqual([255, 0, 0, 255]);
    // Прозрачные клетки различимы между собой — это и есть шахматка.
    expect(at(24, 8)![0]).not.toBe(at(40, 8)![0]);
    // И полностью непрозрачны: под ассетом больше нет «дыры».
    expect(at(24, 8)![3]).toBe(255);
  });
});
