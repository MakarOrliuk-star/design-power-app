import { describe, it, expect, vi, beforeEach } from "vitest";
import sharp from "sharp";

const cloud = vi.hoisted(() => ({
  uploadBuffer: vi.fn(),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock("../src/lib/cloudinary.js", () => cloud);

import {
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
