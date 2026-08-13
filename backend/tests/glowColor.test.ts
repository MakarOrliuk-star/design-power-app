import { describe, it, expect, beforeEach, vi } from "vitest";
import sharp from "sharp";

const fal = vi.hoisted(() => ({ runVisionQa: vi.fn() }));
vi.mock("../src/lib/fal.js", () => fal);

import {
  fallbackGlowHex,
  normalizeGlowHex,
  parseGlowAnswer,
  parseHex,
  pickGlowColor,
  GLOW_MAX_L,
  GLOW_MAX_S,
  GLOW_MIN_L,
  GLOW_MIN_S,
} from "../src/lib/glowColor.js";

/**
 * Выбор цвета свечения (TASK glow-fade-density, DI3-2). Основной путь —
 * арт-директор-VLM; проверяется, что ЛЮБОЙ его ответ приводится к коридору
 * эталонов, а сбой уводит в детерминированный фолбэк по гистограмме.
 */

/** Насыщенность/светлота в HSL — чтобы проверять коридор нормализации. */
function hsl(hex: string): { s: number; l: number } {
  const [r, g, b] = parseHex(hex)!;
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : l > 0.5 ? d / (2 - max - min) : d / (max + min);
  return { s, l };
}

beforeEach(() => {
  fal.runVisionQa.mockReset();
});

describe("parseHex", () => {
  it("принимает #RRGGBB, #RGB и без решётки, отвергает мусор", () => {
    expect(parseHex("#C8EAEF")).toEqual([200, 234, 239]);
    expect(parseHex("0F0")).toEqual([0, 255, 0]);
    expect(parseHex("не цвет")).toBeNull();
    expect(parseHex("#12345")).toBeNull();
  });
});

describe("normalizeGlowHex — коридор эталонов", () => {
  it("цвета трёх эталонов проходят почти без изменений", () => {
    // Коридор откалиброван по ним: правка констант, ломающая этот тест,
    // означает уход от утверждённого дизайнером вида.
    expect(normalizeGlowHex("#2FCDD1")).toBe("#2FCDD1");
    expect(normalizeGlowHex("#FFB70E")).toBe("#FFB70E");
    const green = hsl(normalizeGlowHex("#04AE60"));
    expect(green.l).toBeLessThanOrEqual(GLOW_MAX_L + 0.01);
    expect(green.s).toBeGreaterThanOrEqual(GLOW_MIN_S);
  });

  it("тон сохраняется, светлота и насыщенность держатся в коридоре", () => {
    const out = normalizeGlowHex("#7FD4E0"); // бирюза
    const { s, l } = hsl(out);
    expect(l).toBeGreaterThanOrEqual(GLOW_MIN_L - 0.01);
    expect(l).toBeLessThanOrEqual(GLOW_MAX_L + 0.01);
    expect(s).toBeGreaterThanOrEqual(GLOW_MIN_S - 0.01);
    expect(s).toBeLessThanOrEqual(GLOW_MAX_S + 0.01);
    const [r, g, b] = parseHex(out)!;
    expect(b).toBeGreaterThan(r); // тон остался холодным
  });

  it("выцветший цвет дотягивается до насыщенности эталонов", () => {
    const { s } = hsl(normalizeGlowHex("#BFC8C6")); // почти серый, но с тоном
    expect(s).toBeGreaterThanOrEqual(GLOW_MIN_S - 0.01);
  });

  it("ахроматичный вход и мусор дают тёплый нейтральный, а не бледно-красный", () => {
    const black = normalizeGlowHex("#000000");
    expect(black).toBe(normalizeGlowHex("#808080"));
    expect(black).toBe(normalizeGlowHex("не цвет"));
    const [r, , b] = parseHex(black)!;
    expect(r).toBeGreaterThan(b); // тёплый
  });

  it("идемпотентна: повторная нормализация ничего не меняет", () => {
    const once = normalizeGlowHex("#7FD4E0");
    expect(normalizeGlowHex(once)).toBe(once);
  });
});

describe("fallbackGlowHex — акцент по гистограмме", () => {
  /** Крупное тёмное пятно + маленький насыщенный акцент на прозрачном фоне. */
  async function frame(accent: { r: number; g: number; b: number }): Promise<Buffer> {
    return sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 40, height: 40, channels: 4, background: { r: 20, g: 20, b: 24, alpha: 1 } },
          })
            .png()
            .toBuffer(),
          left: 0,
          top: 0,
        },
        {
          input: await sharp({
            create: { width: 12, height: 12, channels: 4, background: { ...accent, alpha: 1 } },
          })
            .png()
            .toBuffer(),
          left: 48,
          top: 48,
        },
      ])
      .png()
      .toBuffer();
  }

  it("побеждает насыщенный акцент, а не крупное тёмное пятно", async () => {
    const hex = await fallbackGlowHex(await frame({ r: 240, g: 200, b: 40 }));
    const [r, g, b] = parseHex(hex)!;
    expect(r).toBeGreaterThan(b);
    expect(g).toBeGreaterThan(b); // золотой тон сохранён
  });

  it("тон акцента определяет результат", async () => {
    const warm = await fallbackGlowHex(await frame({ r: 240, g: 200, b: 40 }));
    const cold = await fallbackGlowHex(await frame({ r: 40, g: 200, b: 240 }));
    expect(warm).not.toBe(cold);
    expect(parseHex(cold)![2]).toBeGreaterThan(parseHex(cold)![0]);
  });

  it("кадр без насыщенных пикселей → тёплый нейтральный (не падает)", async () => {
    const grey = await sharp({
      create: { width: 32, height: 32, channels: 4, background: { r: 90, g: 90, b: 90, alpha: 1 } },
    })
      .png()
      .toBuffer();
    expect(await fallbackGlowHex(grey)).toBe(normalizeGlowHex("#000000"));
  });

  it("результат всегда нормализован", async () => {
    const { s, l } = hsl(await fallbackGlowHex(await frame({ r: 255, g: 0, b: 0 })));
    expect(l).toBeGreaterThanOrEqual(GLOW_MIN_L - 0.01);
    expect(l).toBeLessThanOrEqual(GLOW_MAX_L + 0.01);
    expect(s).toBeLessThanOrEqual(GLOW_MAX_S + 0.01);
  });
});

describe("parseGlowAnswer", () => {
  it("вытаскивает JSON из markdown-обёртки", () => {
    expect(parseGlowAnswer('```json\n{"hex":"#7FD4E0","reason":"бирюза"}\n```')).toEqual({
      hex: "#7FD4E0",
      reason: "бирюза",
    });
  });

  it("невалидный hex или сломанный JSON → null", () => {
    expect(parseGlowAnswer('{"hex":"бирюзовый"}')).toBeNull();
    expect(parseGlowAnswer("нет json")).toBeNull();
  });
});

/** Кадр для фолбэка: golden-акцент, чтобы результат отличался от нейтрального. */
const goldFrame = await sharp({
  create: { width: 32, height: 32, channels: 4, background: { r: 240, g: 200, b: 40, alpha: 1 } },
})
  .png()
  .toBuffer();

describe("pickGlowColor — VLM с фолбэком (R-P3)", () => {
  const buffer = goldFrame;

  it("ответ модели нормализуется и помечается источником vlm", async () => {
    fal.runVisionQa.mockResolvedValue({
      success: true,
      output: '{"hex":"#00FF00","reason":"зелень долларов"}',
    });
    const res = await pickGlowColor({ imageUrl: "https://cdn/a.png", refUrls: [], buffer });
    expect(res.source).toBe("vlm");
    expect(res.hex).toBe(normalizeGlowHex("#00FF00"));
    expect(res.reason).toBe("зелень долларов");
  });

  it("транспортный сбой → детерминированный фолбэк по кадру", async () => {
    fal.runVisionQa.mockResolvedValue({ success: false, error: "HTTP 500" });
    const res = await pickGlowColor({ imageUrl: "https://cdn/a.png", refUrls: [], buffer });
    expect(res.source).toBe("fallback");
    expect(res.reason).toBe("HTTP 500");
    expect(res.hex).toBe(await fallbackGlowHex(buffer));
  });

  it("неразобранный ответ → фолбэк с причиной", async () => {
    fal.runVisionQa.mockResolvedValue({ success: true, output: "бирюзовый, наверное" });
    const res = await pickGlowColor({ imageUrl: "https://cdn/a.png", refUrls: [], buffer });
    expect(res.source).toBe("fallback");
    expect(res.reason).toBe("glow-color-unparseable");
  });

  it("композиция идёт первой картинкой, референсы — следом (не более трёх)", async () => {
    fal.runVisionQa.mockResolvedValue({ success: true, output: '{"hex":"#7FD4E0"}' });
    await pickGlowColor({
      imageUrl: "https://cdn/a.png",
      refUrls: ["r1", "r2", "r3", "r4"],
      buffer,
    });
    const [args] = fal.runVisionQa.mock.calls[0]!;
    expect((args as { imageUrls: string[] }).imageUrls).toEqual([
      "https://cdn/a.png",
      "r1",
      "r2",
      "r3",
    ]);
  });
});
