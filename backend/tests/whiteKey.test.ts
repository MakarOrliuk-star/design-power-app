import { describe, it, expect, afterEach } from "vitest";
import sharp from "sharp";
import {
  cutoutMode,
  floodFillBackground,
  keyWhiteBackground,
  keyWhiteBackgroundDetailed,
  mergeCutoutAlpha,
  BG_LUMA_MIN,
} from "../src/lib/whiteKey.js";

/**
 * Вырезание по связному белому фону (правка 2026-08-14). Смысл теста —
 * зафиксировать ровно то, чем этот кей отличается от Bria: он не решает, что
 * в кадре главное, поэтому не может потерять парящий предмет, и он оставляет
 * белые детали ВНУТРИ объекта (белая панама героя в эталоне `push1 ok`).
 */

const W = 60;
const H = 40;

async function rgba(buf: Buffer) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    at: (x: number, y: number) => {
      const i = (y * info.width + x) * 4;
      return { r: data[i]!, g: data[i + 1]!, b: data[i + 2]!, a: data[i + 3]! };
    },
  };
}

/** Белый холст: тёмный «герой» по центру и маленький «пропс» в углу. */
async function scene(): Promise<Buffer> {
  const block = (w: number, h: number, c: number) =>
    sharp({ create: { width: w, height: h, channels: 3, background: { r: c, g: c, b: c } } })
      .png()
      .toBuffer();
  return sharp({ create: { width: W, height: H, channels: 3, background: "#fff" } })
    .composite([
      { input: await block(16, 20, 40), left: 22, top: 10 }, // герой
      { input: await block(6, 6, 30), left: 3, top: 3 }, // парящий пропс
      { input: await block(4, 4, 252), left: 28, top: 12 }, // белая деталь ВНУТРИ героя
    ])
    .png()
    .toBuffer();
}

afterEach(() => {
  delete process.env.AI_REF_CUTOUT;
});

describe("floodFillBackground", () => {
  it("заливает только белое, связанное с краями", () => {
    const gray = new Uint8Array(9).fill(255);
    gray[4] = 10; // тёмный центр
    const bg = floodFillBackground(gray, 3, 3, BG_LUMA_MIN);
    expect(bg[0]).toBe(1);
    expect(bg[4]).toBe(0);
  });

  it("белый остров, окружённый тёмным, фоном НЕ считается", () => {
    // 5×5: рамка белая, кольцо тёмное, центр белый.
    const gray = new Uint8Array(25).fill(255);
    for (const i of [6, 7, 8, 11, 13, 16, 17, 18]) gray[i] = 20;
    const bg = floodFillBackground(gray, 5, 5, BG_LUMA_MIN);
    expect(bg[0]).toBe(1); // угол — фон
    expect(bg[12]).toBe(0); // белый остров внутри — не фон
  });
});

describe("keyWhiteBackground", () => {
  it("фон прозрачный, герой и парящий пропс непрозрачны", async () => {
    const px = await rgba(await keyWhiteBackground(await scene()));
    expect(px.at(59, 39).a).toBe(0); // угол
    expect(px.at(30, 20).a).toBe(255); // герой
    expect(px.at(5, 5).a).toBe(255); // пропс, который Bria стирала
  });

  it("белая деталь ВНУТРИ объекта остаётся непрозрачной", async () => {
    const px = await rgba(await keyWhiteBackground(await scene()));
    const white = px.at(29, 13);
    expect(white.a).toBe(255);
    expect(white.r).toBeGreaterThan(240); // цвет не тронут
  });

  it("цвета не меняются — правится только альфа", async () => {
    const src = await scene();
    const before = await rgba(src);
    const after = await rgba(await keyWhiteBackground(src));
    expect(after.at(30, 20).r).toBe(before.at(30, 20).r);
  });
});

describe("mergeCutoutAlpha", () => {
  it("возвращает объект, стёртый Bria, и сохраняет её кромку", async () => {
    const src = await scene();
    const keyed = await keyWhiteBackground(src);
    // Имитация Bria: герой оставлен, парящий пропс стёрт в ноль.
    const { data, info } = await sharp(keyed).raw().toBuffer({ resolveWithObject: true });
    const bria = Buffer.from(data);
    for (let y = 0; y < 12; y++)
      for (let x = 0; x < 12; x++) bria[(y * info.width + x) * 4 + 3] = 0;

    const merged = await mergeCutoutAlpha(
      await sharp(bria, { raw: { width: info.width, height: info.height, channels: 4 } })
        .png()
        .toBuffer(),
      keyed,
    );
    const px = await rgba(merged);
    expect(px.at(5, 5).a).toBe(255); // пропс вернулся из кея
    expect(px.at(30, 20).a).toBe(255); // герой на месте
    expect(px.at(59, 39).a).toBe(0); // фон остался прозрачным
  });
});

describe("cutoutMode", () => {
  it("дефолт — гибрид, env переключает, мусор игнорируется", () => {
    expect(cutoutMode()).toBe("hybrid");
    process.env.AI_REF_CUTOUT = "bria";
    expect(cutoutMode()).toBe("bria");
    process.env.AI_REF_CUTOUT = "white";
    expect(cutoutMode()).toBe("white");
    process.env.AI_REF_CUTOUT = "чепуха";
    expect(cutoutMode()).toBe("hybrid");
  });
});

/**
 * Сквозные отверстия (правка 2026-08-17, заказчик: «объект должен быть
 * сквозным, а она заполнила пустоту белым цветом»).
 *
 * Заливка фона идёт ОТ КРАЁВ, поэтому белое внутри замкнутого контура —
 * дырка бублика, просвет между рукой и корпусом — оставалось непрозрачным и
 * вылезало белой кляксой на цветной подложке письма. Снимать связность
 * нельзя: она защищает белые ПРЕДМЕТЫ. Разделяем по плоскости заливки.
 */
describe("сквозные отверстия", () => {
  /** Кадр W×H: тёмное кольцо, внутри — плоско-белая дырка 10×10. */
  async function donut(fill: { flat: true } | { flat: false }): Promise<Buffer> {
    const ring = await sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 30, g: 30, b: 30 } },
    })
      .png()
      .toBuffer();
    // Плоская заливка = просвет фона; градиент = белый предмет со светотенью.
    const inner = fill.flat
      ? await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } })
          .png()
          .toBuffer()
      : await sharp(
          Buffer.from(
            Uint8Array.from(
              Array.from({ length: 10 * 10 }, (_, k) => {
                const v = 246 + Math.round((k % 10) * 0.9); // 246..254 — разброс 8
                return [v, v, v];
              }).flat(),
            ),
          ),
          { raw: { width: 10, height: 10, channels: 3 } },
        )
          .png()
          .toBuffer();
    return sharp({ create: { width: W, height: H, channels: 3, background: "#fff" } })
      .composite([
        { input: ring, left: 20, top: 10 },
        { input: inner, left: 25, top: 15 },
      ])
      .png()
      .toBuffer();
  }

  it("плоско-белая пустота внутри объекта становится прозрачной", async () => {
    const res = await keyWhiteBackgroundDetailed(await donut({ flat: true }));
    expect(res.holes).toBe(1);
    const px = await rgba(res.png);
    expect(px.at(30, 20).a).toBe(0); // центр дырки — сквозной
    expect(px.at(21, 11).a).toBe(255); // само кольцо цело
  });

  it("белый ПРЕДМЕТ со светотенью не пробивается", async () => {
    const res = await keyWhiteBackgroundDetailed(await donut({ flat: false }));
    // Разброс яркости выдаёт объект, а не заливку фона.
    expect(res.holes).toBe(0);
    expect(res.keptWhiteRegions).toBe(1);
    const px = await rgba(res.png);
    expect(px.at(30, 20).a).toBe(255);
  });

  it("слишком крупная замкнутая область не выбивается", async () => {
    // Половина кадра плоско-белая и замкнута рамкой — это не «дырка», а
    // развалившаяся композиция; сквозная прореха в середине хуже белого.
    const frame = await sharp({
      create: { width: W - 4, height: H - 4, channels: 3, background: { r: 30, g: 30, b: 30 } },
    })
      .png()
      .toBuffer();
    const big = await sharp({
      create: { width: W - 12, height: H - 12, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();
    const src = await sharp({ create: { width: W, height: H, channels: 3, background: "#fff" } })
      .composite([
        { input: frame, left: 2, top: 2 },
        { input: big, left: 6, top: 6 },
      ])
      .png()
      .toBuffer();
    const res = await keyWhiteBackgroundDetailed(src);
    expect(res.holes).toBe(0);
  });

  it("маска отверстий побеждает Bria при слиянии", async () => {
    // Bria сегментирует объект СПЛОШНЫМ силуэтом: внутри дырки у неё альфа
    // 255. Без маски максимум альф вернул бы белую кляксу обратно, и вся
    // правка не работала бы в дефолтном (гибридном) режиме.
    const src = await donut({ flat: true });
    const white = await keyWhiteBackgroundDetailed(src);
    const briaOpaque = await sharp(src).ensureAlpha().png().toBuffer();

    const withoutMask = await rgba(await mergeCutoutAlpha(briaOpaque, white.png));
    expect(withoutMask.at(30, 20).a).toBe(255); // фиксируем природу проблемы

    const withMask = await rgba(await mergeCutoutAlpha(briaOpaque, white.png, white.holeMask));
    expect(withMask.at(30, 20).a).toBe(0);
  });

  it("маска чужого размера игнорируется, а не пробивает случайные места", async () => {
    const src = await donut({ flat: true });
    const white = await keyWhiteBackgroundDetailed(src);
    const bria = await sharp(src).ensureAlpha().png().toBuffer();
    const merged = await mergeCutoutAlpha(bria, white.png, new Uint8Array(7));
    expect((await rgba(merged)).at(30, 20).a).toBe(255);
  });
});
