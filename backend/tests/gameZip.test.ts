import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  assetNameOf,
  classifyByPath,
  classifyByPixels,
  classifyEntry,
  extensionOf,
  isUsableEntry,
} from "../src/lib/gameZip.js";

/**
 * BE Test — designer ZIP intake (TASK game-manager, Phase 2).
 *
 * Q11 left the real archive layout open, so the classifier is layered: folders,
 * then file names, then pixels. These tests pin each layer separately, which is
 * what makes swapping one of them cheap once the customer's archive arrives.
 */

describe("isUsableEntry", () => {
  it("accepts the three supported formats (Q12)", () => {
    expect(isUsableEntry("background/city.png")).toBe(true);
    expect(isUsableEntry("bg/city.JPG")).toBe(true);
    expect(isUsableEntry("a/b/hero.jpeg")).toBe(true);
    expect(isUsableEntry("hero.webp")).toBe(true);
  });

  it("rejects non-images and directories", () => {
    expect(isUsableEntry("notes.txt")).toBe(false);
    expect(isUsableEntry("design.psd")).toBe(false);
    expect(isUsableEntry("background/")).toBe(false);
    expect(isUsableEntry("image.png.zip")).toBe(false);
  });

  it("rejects archive junk", () => {
    expect(isUsableEntry("__MACOSX/._hero.png")).toBe(false);
    expect(isUsableEntry(".DS_Store")).toBe(false);
    expect(isUsableEntry("folder/._hero.png")).toBe(false);
  });

  it("rejects zip-slip and absolute paths", () => {
    expect(isUsableEntry("../../etc/passwd.png")).toBe(false);
    expect(isUsableEntry("a/../../b.png")).toBe(false);
    expect(isUsableEntry("/abs/hero.png")).toBe(false);
    expect(isUsableEntry("C:/win/hero.png")).toBe(false);
  });
});

describe("extensionOf", () => {
  it("lower-cases and handles a missing extension", () => {
    expect(extensionOf("A.PNG")).toBe(".png");
    expect(extensionOf("noext")).toBe("");
  });
});

describe("classifyByPath", () => {
  it("reads the folder first — in either language", () => {
    expect(classifyByPath("Background/anything.png")).toBe("BACKGROUND");
    expect(classifyByPath("фоны/anything.png")).toBe("BACKGROUND");
    expect(classifyByPath("persons/anything.png")).toBe("PERSON");
    expect(classifyByPath("Персонажи/anything.png")).toBe("PERSON");
  });

  it("treats the mock's 'Item' wording as the person layer (Q5)", () => {
    expect(classifyByPath("items/dealer.png")).toBe("PERSON");
  });

  it("falls back to the file name when folders say nothing", () => {
    expect(classifyByPath("assets/casino_bg.png")).toBe("BACKGROUND");
    expect(classifyByPath("assets/hero_1.png")).toBe("PERSON");
  });

  it("lets the folder win over a misleading file name", () => {
    // "…_background_final" is a common export suffix on a character file.
    expect(classifyByPath("person/dealer_background_final.png")).toBe("PERSON");
  });

  it("returns null when nothing in the path hints either way", () => {
    expect(classifyByPath("assets/img_0042.png")).toBeNull();
  });
});

/** Solid image, no alpha channel at all. */
const opaqueJpegLike = () =>
  sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toBuffer();

/** Alpha channel present but fully opaque — a very common PNG export. */
const opaqueWithAlpha = () =>
  sharp({
    create: { width: 40, height: 40, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
  })
    .png()
    .toBuffer();

/** A cut-out: a small solid blob inside a transparent frame. */
const transparentCutout = () =>
  sharp({
    create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: {
          create: { width: 30, height: 30, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
        },
        left: 35,
        top: 35,
      },
    ])
    .png()
    .toBuffer();

describe("classifyByPixels", () => {
  it("calls an image with no alpha channel a background", async () => {
    expect(await classifyByPixels(await opaqueJpegLike())).toBe("BACKGROUND");
  });

  it("calls an opaque alpha channel a background, not a cut-out", async () => {
    expect(await classifyByPixels(await opaqueWithAlpha())).toBe("BACKGROUND");
  });

  it("calls a real cut-out a person", async () => {
    expect(await classifyByPixels(await transparentCutout())).toBe("PERSON");
  });

  it("does not throw on bytes that are not an image", async () => {
    expect(await classifyByPixels(Buffer.from("definitely not a png"))).toBe("BACKGROUND");
  });
});

describe("classifyEntry", () => {
  it("prefers the path over the pixels", async () => {
    // Transparent cut-out sitting in a background/ folder — the designer's
    // filing wins, because that is the deliberate signal.
    expect(await classifyEntry("background/odd.png", await transparentCutout())).toBe("BACKGROUND");
  });

  it("falls back to pixels for an unnamed file", async () => {
    expect(await classifyEntry("assets/img_1.png", await transparentCutout())).toBe("PERSON");
    expect(await classifyEntry("assets/img_2.png", await opaqueJpegLike())).toBe("BACKGROUND");
  });
});

describe("assetNameOf", () => {
  it("keeps the base name, drops the extension and the path", () => {
    expect(assetNameOf("background/city_night.png")).toBe("city_night");
  });

  it("sanitises separators but keeps Cyrillic", () => {
    expect(assetNameOf("a/фон дилер.png")).toBe("фон_дилер");
  });

  it("never returns an empty id", () => {
    expect(assetNameOf("!!!.png")).toBe("asset");
  });
});
