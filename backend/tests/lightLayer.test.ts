import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  keyLightLayer,
  normalizeLightLayer,
  lightCenterLuminance,
  lightLayerHasObjects,
  LIGHT_ALPHA_GAIN,
} from "../src/lib/lightLayer.js";

/**
 * Слой света (Фаза 4, D-N6). Кейинг, нормировка под коридор и Enforce
 * проверяются на синтетике: настоящая генерация — scripts/try-composition.ts.
 */

/** RGB-холст с плавным горизонтальным градиентом от чёрного к серому. */
async function gradient(w: number, h: number, peak = 120): Promise<Buffer> {
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Пик в центре, спад к краям — грубая модель радиального свечения.
      const dx = Math.abs(x - w / 2) / (w / 2);
      const dy = Math.abs(y - h / 2) / (h / 2);
      const v = Math.round(peak * Math.max(0, 1 - Math.max(dx, dy)));
      const i = (y * w + x) * 3;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/** Тот же градиент, но с резким «объектом» — белым квадратом. */
async function gradientWithObject(w: number, h: number): Promise<Buffer> {
  const base = await gradient(w, h);
  const obj = await sharp({
    create: { width: 60, height: 60, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .png()
    .toBuffer();
  return sharp(base).composite([{ input: obj, left: Math.round(w * 0.6), top: Math.round(h * 0.4) }]).png().toBuffer();
}

describe("keyLightLayer — alpha = f(яркость), D-N6", () => {
  it("чёрное прозрачно, серое полупрозрачно, цвет сохраняется", async () => {
    const src = await sharp({
      create: { width: 8, height: 4, channels: 3, background: { r: 80, g: 60, b: 20 } },
    })
      .png()
      .toBuffer();
    const keyed = await keyLightLayer(src);
    const { data } = await sharp(keyed).raw().toBuffer({ resolveWithObject: true });
    const lum = 0.2126 * 80 + 0.7152 * 60 + 0.0722 * 20;
    expect(data[0]).toBe(80);
    expect(data[1]).toBe(60);
    expect(data[2]).toBe(20);
    expect(data[3]).toBe(Math.min(255, Math.round(lum * LIGHT_ALPHA_GAIN)));

    const black = await keyLightLayer(
      await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } } })
        .png()
        .toBuffer(),
    );
    const bd = await sharp(black).raw().toBuffer({ resolveWithObject: true });
    expect(bd.data[3]).toBe(0); // f(0) = 0 при любом гейне
  });

  it("детерминирован: те же байты → те же байты", async () => {
    const src = await gradient(64, 32);
    expect((await keyLightLayer(src)).equals(await keyLightLayer(src))).toBe(true);
  });
});

describe("normalizeLightLayer — яркость центра подгоняется к коридору", () => {
  it("после нормировки центр композита в середине целевого диапазона", async () => {
    const keyed = await keyLightLayer(await gradient(240, 120, 220));
    const normalized = await normalizeLightLayer(keyed, { centerLum: [17, 38] });
    const lum = await lightCenterLuminance(normalized);
    expect(lum).toBeGreaterThan(17);
    expect(lum).toBeLessThan(38);
  });

  it("тянет вверх слишком тёмный слой", async () => {
    const keyed = await keyLightLayer(await gradient(240, 120, 40));
    const before = await lightCenterLuminance(keyed);
    const normalized = await normalizeLightLayer(keyed, { centerLum: [17, 38] });
    const after = await lightCenterLuminance(normalized);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(17 * 0.9);
  });
});

describe("lightLayerHasObjects — Enforce «нет объектов»", () => {
  it("чистая атмосфера проходит", async () => {
    expect(await lightLayerHasObjects(await gradient(512, 256))).toBe(false);
  });

  it("резкий объект в слое ловится — его кейинг превратил бы в призрак", async () => {
    expect(await lightLayerHasObjects(await gradientWithObject(512, 256))).toBe(true);
  });
});
