import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  measure,
  checkAgainstSpec,
  type PatternSpec,
  type CorridorReport,
} from "../src/lib/patternMiner.js";
import { mineCorpus } from "../scripts/mine-pattern.js";

/**
 * ГЛАВНЫЙ ПРИЁМОЧНЫЙ ТЕСТ валидатора (TASK Фаза 5, §8):
 *
 *   «валидатор пропускает все пять эталонов без единого ложного срабатывания
 *    и бракует result-2 минимум по V2, V4, V5, V7, V8, V9, V11».
 *
 * Это ровно претензия П-5 наоборот: добыча и проверка — один код (D-C2), и
 * если этот тест зелёный, коридоры не могут разъехаться с корпусом. V13
 * (слоты заполнены, содержимое не проверяется) — не метрика майнера, её
 * закрывают кластеры V11/V12 и заполненность зон V4/V5.
 */

const EXAMPLES = path.resolve(__dirname, "../../figma/crm-bundle/examples");
const REFS = ["1.jfif", "2.jfif", "3.jfif", "4.jfif", "5.jfif"];

/** Проверки TASK Фазы 5 → метрики майнера. */
const MUST_FAIL_ON_RESULT2: Record<string, string[]> = {
  "V2 (прозрачных = 0)": ["transparentPct"],
  "V4 (scene-top заполнен)": ["bandTopThird"],
  "V5 (scene-bottom заполнен)": ["bandBottomThird"],
  "V7 (объекты и площадь декора)": ["decorCount", "decorAreaPct"],
  "V8 (разброс резкости ≥ 10×)": ["sharpnessSpread"],
  "V9 (подрезан верхом)": ["croppedTop"],
  "V11 (высота item-кластера)": ["itemClusterHeightPct"],
};

let spec: PatternSpec;

beforeAll(async () => {
  spec = (await mineCorpus(EXAMPLES)).spec;
}, 120_000);

describe("приёмка валидатора: 5/5 эталонов проходят, result-2 падает", () => {
  for (const name of REFS) {
    it(`эталон ${name} проходит ВСЕ коридоры — ни одного ложного срабатывания`, async () => {
      const { metrics } = await measure(await readFile(path.join(EXAMPLES, name)));
      const report = checkAgainstSpec(metrics, spec);
      const failed = report.checks.filter((c) => !c.passed).map((c) => `${c.key}: ${c.detail}`);
      expect(failed, `валидатор бракует собственный корпус:\n${failed.join("\n")}`).toEqual([]);
    }, 60_000);
  }

  it("result-2 бракуется по каждой из проверок TASK Фазы 5", async () => {
    const { metrics } = await measure(await readFile(path.join(EXAMPLES, "result-2.png")));
    const report: CorridorReport = checkAgainstSpec(metrics, spec);
    expect(report.passed).toBe(false);

    for (const [check, keys] of Object.entries(MUST_FAIL_ON_RESULT2)) {
      const hit = keys.some((k) => report.failedKeys.includes(k));
      expect(hit, `${check}: result-2 обязан падать по ${keys.join("/")}, а не прошёл`).toBe(true);
    }
  }, 60_000);

  it("диагноз §3.3 воспроизводится числами: пустой холст с двумя вырезками", async () => {
    const { metrics } = await measure(await readFile(path.join(EXAMPLES, "result-2.png")));
    expect(metrics.transparentPct).toBeGreaterThan(70); // 77.5 % дыры
    expect(metrics.decorCount).toBeLessThanOrEqual(3); // 2 объекта декора против 7–17
    expect(metrics.sharpnessSpread).toBeLessThan(2); // все объекты одинаково-острые
    expect(metrics.croppedTop).toBe(0); // приём 5/5 отсутствует
  }, 60_000);
});
