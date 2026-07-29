import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  assertFontAvailable,
  buildTokenSvg,
  detectFontSubstitution,
  formatFontStack,
  renderToken,
  resolveMaterial,
  TYPO_MATERIALS,
  DEFAULT_MATERIAL_KEY,
  deriveTokens,
  MAX_TOKEN_CHARS,
} from "../src/lib/typography3d.js";

// П7 — 3D-типографика рисуется кодом через librsvg (Задание 2, Фаза 2).
// Смысл этих тестов: надпись обязана быть точной, объёмной и воспроизводимой,
// потому что альтернатива — просить текст у генератора, который его искажает.

const base = {
  fontSizePx: 96,
  material: TYPO_MATERIALS[DEFAULT_MATERIAL_KEY]!,
  skewDeg: 0,
  rotateDeg: 0,
  bevel: true,
  specular: true,
  ownShadow: true,
} as const;

describe("formatFontStack", () => {
  it("quotes families with spaces and leaves generics bare", () => {
    expect(formatFontStack("Arial Black, sans-serif")).toBe("'Arial Black', sans-serif");
  });

  it("quotes names containing digits — unquoted они ломают CSS-декларацию", () => {
    // Именно на этом ранее молча ломался детектор подстановки: librsvg
    // выбрасывал невалидную декларацию и рисовал другим шрифтом.
    expect(formatFontStack("Font 2000")).toBe("'Font 2000'");
  });

  it("normalizes already-quoted input instead of double-quoting", () => {
    expect(formatFontStack("'Arial Black'")).toBe("'Arial Black'");
  });

  it("drops empty entries", () => {
    expect(formatFontStack("A, , B")).toBe("'A', 'B'");
  });
});

describe("buildTokenSvg", () => {
  it("escapes the token instead of injecting it into markup", () => {
    const svg = buildTokenSvg({ ...base, token: "<script>&" });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&#60;");
  });

  it("emits the depth cues the эталоны use: gradient body, bevel, specular, shadow", () => {
    const svg = buildTokenSvg({ ...base, token: "BIG WIN" });
    expect(svg).toContain('<linearGradient id="body"');
    expect(svg).toContain('fill="url(#body)"');
    expect(svg).toContain("stroke-width"); // фаска
    expect(svg).toContain("clip-path=\"url(#topThird)\""); // блик
    expect(svg).toContain("feGaussianBlur"); // собственная тень
  });

  it("omits each cue when it is switched off", () => {
    const flat = buildTokenSvg({
      ...base,
      token: "FS",
      bevel: false,
      specular: false,
      ownShadow: false,
    });
    expect(flat).not.toContain("topThird");
    expect(flat).not.toContain("feGaussianBlur");
  });

  it("applies perspective as rotate + skew around the text centre", () => {
    const svg = buildTokenSvg({ ...base, token: "FS", skewDeg: 12, rotateDeg: -6 });
    expect(svg).toContain("rotate(-6");
    expect(svg).toContain("skewX(-12)");
  });
});

describe("renderToken", () => {
  it("produces an alpha PNG trimmed to the glyphs", async () => {
    const r = await renderToken({ ...base, token: "FS" });
    const meta = await sharp(r.png).metadata();
    expect(meta.format).toBe("png");
    expect(meta.hasAlpha).toBe(true);
    expect(meta.width).toBe(r.width);
    expect(meta.height).toBe(r.height);
    // Обрезано по буквам: холст строится с большим запасом под тень и наклон.
    expect(r.width).toBeLessThan(base.fontSizePx * 4);
    expect(r.height).toBeLessThan(base.fontSizePx * 2.2);
  });

  it("scales with the requested font size", async () => {
    const small = await renderToken({ ...base, token: "BIG WIN", fontSizePx: 48 });
    const large = await renderToken({ ...base, token: "BIG WIN", fontSizePx: 144 });
    expect(large.width).toBeGreaterThan(small.width * 2);
  });

  it("is byte-deterministic — same input, same bytes", async () => {
    const a = await renderToken({ ...base, token: "SCATTER" });
    const b = await renderToken({ ...base, token: "SCATTER" });
    expect(a.png.equals(b.png)).toBe(true);
  });

  it("renders different tokens differently (текст реально дошёл до растра)", async () => {
    const fs = await renderToken({ ...base, token: "FS" });
    const win = await renderToken({ ...base, token: "BIG WIN" });
    expect(fs.png.equals(win.png)).toBe(false);
    expect(win.width).toBeGreaterThan(fs.width);
  });
});

describe("resolveMaterial", () => {
  it("resolves a plain key", () => {
    expect(resolveMaterial("neon")).toBe(TYPO_MATERIALS.neon);
  });

  it("resolves the spec's dotted reference form", () => {
    // Спека хранит "brand.typo_material" — движок не должен на этом падать.
    expect(resolveMaterial("brand.gold")).toBe(TYPO_MATERIALS.gold);
  });

  it("falls back to gold instead of throwing on an unknown key", () => {
    expect(resolveMaterial("brand.typo_material")).toBe(TYPO_MATERIALS.gold);
    expect(resolveMaterial(undefined)).toBe(TYPO_MATERIALS.gold);
  });
});

describe("font availability", () => {
  it("assertFontAvailable passes while anything renders", async () => {
    const res = await assertFontAvailable();
    expect(res.ok).toBe(true);
  });

  it("detects that an invented family is substituted by fontconfig", async () => {
    // Это и есть та проверка, ради которой модуль существует: fontconfig на
    // неизвестное имя молча подставляет замену, и «отрисовалось» ещё не значит
    // «шрифт есть». Без неё деплой без шрифта проходит незамеченным.
    const res = await detectFontSubstitution("Totally Invented Face Name");
    expect(res.substituted).toBe(true);
  });
});

// ------------------------------------------------------------------
// Токены следуют за кампанией (поправка заказчика 2026-07-28: «не обязательно
// BIG WIN — всё зависит от промпта»). Правило намеренно предсказуемое: что
// написано в брифе КАПСОМ, то и попадает на баннер.
// ------------------------------------------------------------------
describe("deriveTokens", () => {
  it("берёт из брифа то, что написано капсом", () => {
    expect(deriveTokens("Weekend reload: BIG WIN up to 500 EUR")).toContain("BIG WIN");
  });

  it("склеивает соседние капс-слова в одну надпись", () => {
    expect(deriveTokens("Летняя акция CASHBACK 20% и FREE SPINS для всех")).toEqual([
      "CASHBACK 20%",
      "FREE SPINS",
    ]);
  });

  it("работает с кириллицей", () => {
    // `\b` в JS работает по ASCII и кириллицу молча не видит — на этом
    // первая редакция и споткнулась.
    expect(deriveTokens("НОВОГОДНИЙ ДЖЕКПОТ ждёт")).toEqual(["НОВОГОДНИЙ"]);
  });

  it("ничего не выдумывает, когда бриф без капса", () => {
    // Слот с tokensSource: "campaign" в этом случае просто пропускается —
    // навязывать «BIG WIN» неверно.
    expect(deriveTokens("summer promo, soft pastel colors, cute mascot")).toEqual([]);
  });

  it("не тащит голые числа", () => {
    expect(deriveTokens("promo 2026 relaunch")).toEqual([]);
  });

  it("укорачивает длинную фразу по целым словам, а не выбрасывает", () => {
    const t = deriveTokens("МЕГА СУПЕР ОГРОМНЫЙ ДЛИННЮЩИЙ ТОКЕН");
    expect(t).toHaveLength(1);
    expect(t[0]!.length).toBeLessThanOrEqual(MAX_TOKEN_CHARS);
    expect(t[0]!.split(" ").every((w) => w === w.toUpperCase())).toBe(true);
  });

  it("не дублирует один токен и держит потолок количества", () => {
    expect(deriveTokens("WIN and WIN and WIN")).toEqual(["WIN"]);
    expect(deriveTokens("AAA BBB, CCC, DDD, EEE, FFF", 2)).toHaveLength(2);
  });
});
