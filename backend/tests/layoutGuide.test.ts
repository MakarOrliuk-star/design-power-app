import { describe, it, expect, vi, beforeEach } from "vitest";
import sharp from "sharp";

const cloud = vi.hoisted(() => ({
  uploadBuffer: vi.fn(),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock("../src/lib/cloudinary.js", () => cloud);

import {
  buildPropsGuidePng,
  buildLayoutGuidePng,
  getLayoutGuideUrl,
  resetLayoutGuideCache,
} from "../src/lib/layoutGuide.js";

// Схема-раскладка (A-6): серые боковые панели ~27%, белый copy space по центру.

beforeEach(() => {
  cloud.uploadBuffer.mockReset();
  resetLayoutGuideCache();
});

describe("buildLayoutGuidePng", () => {
  it("1200×600: боковые панели серые, центр белый", async () => {
    const png = await buildLayoutGuidePng();
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(1200);
    expect(info.height).toBe(600);
    const px = (x: number, y: number) => data[(y * info.width + x) * info.channels]!;
    expect(px(10, 300)).toBeLessThan(230); // левая панель серая
    expect(px(1190, 300)).toBeLessThan(230); // правая панель серая
    expect(px(600, 300)).toBe(255); // центр белый
    expect(px(400, 300)).toBe(255); // за панелью (27% = 324px) уже белое
  });
});

describe("getLayoutGuideUrl", () => {
  it("заливает один раз и кэширует URL", async () => {
    cloud.uploadBuffer.mockResolvedValue({ success: true, secure_url: "https://cdn/guide.png" });
    expect(await getLayoutGuideUrl()).toBe("https://cdn/guide.png");
    expect(await getLayoutGuideUrl()).toBe("https://cdn/guide.png");
    expect(cloud.uploadBuffer).toHaveBeenCalledTimes(1);
  });

  it("сбой заливки — исключение (пайплайн ловит и генерирует без схемы)", async () => {
    cloud.uploadBuffer.mockResolvedValue({ success: false, error: "boom" });
    await expect(getLayoutGuideUrl()).rejects.toThrow("layout guide upload");
  });
});

// Схема ПРЕДМЕТОВ для push/pop-up (правка 2026-08-14): смысл обратный
// email-схеме — заполнены должны быть бока, а не центр.
describe("buildPropsGuidePng", () => {
  it("боковые трети серые, центр белый, размер = канвасу формата", async () => {
    const png = await buildPropsGuidePng(1024, 512);
    const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(1024);
    expect(info.height).toBe(512);
    const at = (xp: number) =>
      data[Math.floor(info.height / 2) * info.width + Math.floor(xp * info.width)]!;
    expect(at(0.15)).toBeLessThan(230); // левая зона предметов
    expect(at(0.85)).toBeLessThan(230); // правая зона предметов
    expect(at(0.5)).toBe(255); // центр — герой
  });

  it("пропорции держатся на другом канвасе (pop-up 4:3)", async () => {
    const { info } = await sharp(await buildPropsGuidePng(800, 600))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([800, 600]);
  });
});
