import { describe, it, expect } from "vitest";
import { readImageSize, nearestFalAspect } from "../src/lib/imageSize.js";

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(24);
  b.write("GIF89a", 0, "ascii");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function jpegSof0(width: number, height: number): Buffer {
  // SOI + a minimal SOF0 segment carrying height/width.
  const b = Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xc0, // SOF0
    0x00, 0x11, // segment length
    0x08, // precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, // components
    ...new Array(20).fill(0),
  ]);
  return b;
}

describe("readImageSize", () => {
  it("reads PNG dimensions", () => {
    expect(readImageSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(readImageSize(png(512, 512))).toEqual({ width: 512, height: 512 });
  });
  it("reads GIF dimensions", () => {
    expect(readImageSize(gif(640, 480))).toEqual({ width: 640, height: 480 });
  });
  it("reads JPEG (SOF0) dimensions", () => {
    expect(readImageSize(jpegSof0(800, 1200))).toEqual({ width: 800, height: 1200 });
  });
  it("returns null for unknown / too-short data", () => {
    expect(readImageSize(Buffer.from([1, 2, 3]))).toBeNull();
    expect(readImageSize(Buffer.alloc(40))).toBeNull();
  });
});

describe("nearestFalAspect", () => {
  it("maps common dimensions to the closest fal aspect_ratio", () => {
    expect(nearestFalAspect(512, 512)).toBe("1:1");
    expect(nearestFalAspect(1920, 1080)).toBe("16:9");
    expect(nearestFalAspect(1080, 1920)).toBe("9:16");
    expect(nearestFalAspect(1024, 768)).toBe("4:3");
    expect(nearestFalAspect(768, 1024)).toBe("3:4");
  });
  it("snaps near-square to 1:1 and defends against bad input", () => {
    expect(nearestFalAspect(1000, 1010)).toBe("1:1");
    expect(nearestFalAspect(0, 100)).toBe("1:1");
  });
});
