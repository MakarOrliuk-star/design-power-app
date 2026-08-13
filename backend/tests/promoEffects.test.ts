import { describe, it, expect, afterEach } from "vitest";
import sharp from "sharp";
import {
  applyBottomFade,
  applyPromoEffects,
  DEFAULT_EFFECTS,
  DEFAULT_FADE,
  DEFAULT_GLOW,
  NO_EFFECTS,
  fadeFactor,
  recommendedTextColorFor,
  renderGlowLayer,
  resolveEffectsConfig,
  zoneLuminanceOverWhite,
} from "../src/lib/promoEffects.js";

/**
 * Пост-обработка промо-ассетов (TASK glow-fade-density, задания 1–2).
 * Проверяется геометрия альфы, порядок слоёв и идемпотентность —
 * то, на чём держится возможность включать/выключать эффекты без
 * повторной генерации.
 */

const W = 80;
const H = 40;

/** Непрозрачный цветной прямоугольник на прозрачном холсте — «объекты». */
async function artwork(): Promise<Buffer> {
  return sharp({
    create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: await sharp({
          create: { width: 20, height: H, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } },
        })
          .png()
          .toBuffer(),
        left: 10,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
}

async function rgba(buf: Buffer) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    info,
    at(x: number, y: number) {
      const i = (y * info.width + x) * 4;
      return { r: data[i]!, g: data[i + 1]!, b: data[i + 2]!, a: data[i + 3]! };
    },
  };
}

afterEach(() => {
  delete process.env.AI_REF_EFFECTS;
});

describe("fadeFactor — кривая гашения (DI3-6)", () => {
  it("выше полосы фейда альфа не трогается, на нижней строке гаснет в ноль", () => {
    const cfg = { heightPct: 0.2 }; // 20 % от 100 px = 20 px
    expect(fadeFactor(0, 100, cfg)).toBe(1);
    expect(fadeFactor(79, 100, cfg)).toBe(1);
    expect(fadeFactor(99, 100, cfg)).toBe(0);
  });

  it("монотонно убывает и остаётся в [0,1]", () => {
    let prev = 1;
    for (let y = 0; y < 100; y++) {
      const k = fadeFactor(y, 100, DEFAULT_FADE);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThanOrEqual(prev);
      prev = k;
    }
  });

  it("вырожденная полоса (меньше 2 px) фейд не применяет — иначе обрыв кромки", () => {
    expect(fadeFactor(9, 10, { heightPct: 0.05 })).toBe(1);
  });
});

describe("applyBottomFade", () => {
  it("нижняя кромка полностью прозрачна, верх кадра не изменился", async () => {
    const src = await artwork();
    const out = await applyBottomFade(src, DEFAULT_FADE);
    const before = await rgba(src);
    const after = await rgba(out);

    expect(after.at(15, H - 1).a).toBe(0);
    expect(after.at(15, 0).a).toBe(before.at(15, 0).a);
    // Цвет не подменяется — гасится только альфа (DI3-5: фейд по альфе).
    expect(after.at(15, 0).r).toBe(before.at(15, 0).r);
  });

  it("внутри полосы альфа строго между нулём и исходной", async () => {
    const out = await applyBottomFade(await artwork(), DEFAULT_FADE);
    const px = (await rgba(out)).at(15, H - 4);
    expect(px.a).toBeGreaterThan(0);
    expect(px.a).toBeLessThan(255);
  });
});

describe("renderGlowLayer — свечение как фон (задание 1)", () => {
  it("пик в центре, углы прозрачные, цвет сохранён", async () => {
    const layer = await renderGlowLayer(W, H, "#63CBD9", DEFAULT_GLOW);
    const px = await rgba(layer);
    const center = px.at(W / 2, H / 2);
    expect(center.a).toBeGreaterThan(0);
    // Пик не выше заявленной непрозрачности — свечение обязано остаться фоном.
    expect(center.a).toBeLessThanOrEqual(Math.round(DEFAULT_GLOW.peakAlpha * 255) + 1);
    expect(px.at(0, 0).a).toBeLessThan(center.a);
    expect(center.b).toBeGreaterThan(center.r); // голубой остался голубым
  });
});

describe("applyPromoEffects — порядок слоёв и идемпотентность", () => {
  it("свечение ложится ПОД объекты: пиксель объекта не изменил цвет", async () => {
    const src = await artwork();
    const out = await applyPromoEffects(src, {
      glowHex: "#63CBD9",
      config: { glow: DEFAULT_GLOW, fade: null },
    });
    const before = await rgba(src);
    const after = await rgba(out);
    const x = 15;
    const y = 5;
    expect(before.at(x, y).a).toBe(255);
    expect(after.at(x, y)).toEqual(before.at(x, y));
    // А пустой фон рядом получил подсветку.
    expect(before.at(60, y).a).toBe(0);
    expect(after.at(60, y).a).toBeGreaterThan(0);
  });

  it("фейд применяется ПОСЛЕ свечения — гаснет и подсветка тоже", async () => {
    const out = await applyPromoEffects(await artwork(), {
      glowHex: "#63CBD9",
      config: DEFAULT_EFFECTS,
    });
    const px = await rgba(out);
    expect(px.at(40, H - 1).a).toBe(0);
  });

  it("оба эффекта выключены → возвращается ИСХОДНЫЙ буфер без перекодирования", async () => {
    const src = await artwork();
    const out = await applyPromoEffects(src, { glowHex: "#63CBD9", config: NO_EFFECTS });
    expect(out).toBe(src);
  });

  it("без цвета свечения слой пропускается, фейд работает", async () => {
    const src = await artwork();
    const out = await applyPromoEffects(src, { glowHex: null, config: DEFAULT_EFFECTS });
    const px = await rgba(out);
    expect(px.at(60, 5).a).toBe(0); // фон остался пустым — свечения нет
    expect(px.at(15, H - 1).a).toBe(0); // фейд отработал
  });

  it("идемпотентность: повтор от одного источника даёт тот же результат", async () => {
    const src = await artwork();
    const opts = { glowHex: "#63CBD9", config: DEFAULT_EFFECTS };
    const first = await applyPromoEffects(src, opts);
    const second = await applyPromoEffects(src, opts);
    expect(second.equals(first)).toBe(true);
    // А наложение поверх готового результата — уже другая картинка: именно
    // поэтому пере-применение обязано идти от `_transparent` (R-PLAN §3.6).
    const twice = await applyPromoEffects(first, opts);
    expect(twice.equals(first)).toBe(false);
  });
});

describe("resolveEffectsConfig — рубильники (DI3-15)", () => {
  it("поле не задано → оба эффекта включены", () => {
    expect(resolveEffectsConfig(undefined)).toEqual(DEFAULT_EFFECTS);
    expect(resolveEffectsConfig(null)).toEqual(DEFAULT_EFFECTS);
  });

  it("галки формата выключают эффекты по отдельности", () => {
    expect(resolveEffectsConfig({ glow: false })).toEqual({ glow: null, fade: DEFAULT_FADE });
    expect(resolveEffectsConfig({ fade: false })).toEqual({ glow: DEFAULT_GLOW, fade: null });
  });

  it("AI_REF_EFFECTS=off гасит всё поверх галок", () => {
    process.env.AI_REF_EFFECTS = "off";
    expect(resolveEffectsConfig({ glow: true, fade: true })).toEqual(NO_EFFECTS);
  });
});

describe("контраст текста в safe zone (R-I1)", () => {
  it("под свечением рекомендуется тёмный текст", async () => {
    const out = await applyPromoEffects(
      await sharp({
        create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .png()
        .toBuffer(),
      { glowHex: "#63CBD9", config: { glow: DEFAULT_GLOW, fade: null } },
    );
    const lum = await zoneLuminanceOverWhite(out, { x: 0.27, y: 0.04, w: 0.46, h: 0.92 });
    expect(lum).toBeGreaterThan(0.5); // зона осталась светлой
    expect(recommendedTextColorFor(lum)).toBe("#111111");
  });

  it("на тёмном фоне рекомендуется белый текст", () => {
    expect(recommendedTextColorFor(0.02)).toBe("#FFFFFF");
  });
});
