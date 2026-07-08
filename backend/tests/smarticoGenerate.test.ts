import { describe, it, expect } from "vitest";
import {
  generateOutputs,
  generateSmarticoCardOutputs,
  type UrlMap,
} from "../src/lib/smartico/generate.js";
import { buildBrandMap, normalizeBrand, type TypeKey } from "../src/lib/smartico/detect.js";

const brandMap = buildBrandMap(["BrunoCasino", "Corgibet", "God of Coins"]);
const nb = (raw: string) => normalizeBrand(raw, brandMap);

describe("generateOutputs", () => {
  it("builds one function per selected type with canonical brand keys", () => {
    const urls: UrlMap = {
      brunocasino: { email: { default: "https://cdn/x/bruno.png", KO: null } },
      corgibet: { email: { default: "https://cdn/x/corgi.png", KO: null } },
    };
    const blocks = generateOutputs(urls, ["email"], [nb("brunocasino"), nb("corgibet")]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.title).toBe("Email — Function");
    expect(blocks[0]!.kind).toBe("function");
    // canonical names, not raw folder names
    expect(blocks[0]!.code).toContain('"BrunoCasino": "https://cdn/x/bruno.png"');
    expect(blocks[0]!.code).toContain('"Corgibet": "https://cdn/x/corgi.png"');
    expect(blocks[0]!.code).toContain("state.core_sm_brand_id");
    expect(blocks[0]!.code).not.toContain("core_user_language"); // no localization
  });

  it("switches to the locale-aware branch when a brand has default + KO", () => {
    const urls: UrlMap = {
      corgibet: { push: { default: "https://cdn/d.png", KO: "https://cdn/ko.png" } },
    };
    const blocks = generateOutputs(urls, ["push"], [nb("corgibet")]);
    expect(blocks[0]!.code).toContain("core_user_language");
    expect(blocks[0]!.code).toContain('"default": "https://cdn/d.png"');
    expect(blocks[0]!.code).toContain('"KO": "https://cdn/ko.png"');
    expect(blocks[0]!.code).toContain('{{label.dynamic_image_default_unique}}');
  });

  it("emits Pop-up 1 and Pop-up 2 as two separate functions", () => {
    const urls: UrlMap = {
      corgibet: {
        "pop-up_1": { default: "https://cdn/p1.png", KO: null },
        "pop-up_2": { default: "https://cdn/p2.png", KO: null },
      },
    };
    const types: TypeKey[] = ["pop-up_1", "pop-up_2"];
    const blocks = generateOutputs(urls, types, [nb("corgibet")]);
    expect(blocks.map((b) => b.title)).toEqual(["Pop-up 1 — Function", "Pop-up 2 — Function"]);
    expect(blocks[0]!.code).toContain("https://cdn/p1.png");
    expect(blocks[1]!.code).toContain("https://cdn/p2.png");
  });

  it("uses the All brands image as the else-fallback (no separate Сквозной block)", () => {
    const urls: UrlMap = {
      "All brands": { email: { default: "https://cdn/all.png", KO: null } },
      corgibet: { email: { default: "https://cdn/corgi.png", KO: null } },
    };
    const blocks = generateOutputs(urls, ["email"], [nb("All brands"), nb("corgibet")]);
    expect(blocks).toHaveLength(1);
    const fn = blocks[0]!;
    expect(fn.title).toBe("Email — Function");
    expect(fn.code).toContain('"Corgibet": "https://cdn/corgi.png"');
    // the All brands image replaces the label placeholder in the else-branch
    expect(fn.code).toContain('return "https://cdn/all.png";');
    expect(fn.code).not.toContain("{{label.dynamic_image_default_unique}}");
    // All brands must not appear as an individual brand key
    expect(fn.code).not.toContain('"All brands"');
  });

  it("uses the type-less default image (new structure) as the else-fallback", () => {
    const urls: UrlMap = {
      corgibet: { email: { default: "https://cdn/corgi.png", KO: null } },
    };
    const blocks = generateOutputs(urls, ["email"], [nb("corgibet")], "https://cdn/default.png");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.code).toContain('return "https://cdn/default.png";');
    expect(blocks[0]!.code).not.toContain("{{label.dynamic_image_default_unique}}");
  });

  it("still emits the constant Сквозной function when only All brands is present", () => {
    const urls: UrlMap = {
      "All brands": { email: { default: "https://cdn/all.png", KO: null } },
    };
    const blocks = generateOutputs(urls, ["email"], [nb("All brands")]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.title).toBe("Email — All Brands (Сквозной)");
    expect(blocks[0]!.code).toContain('return "https://cdn/all.png";');
    expect(blocks[0]!.code).not.toContain("core_sm_brand_id");
  });

  it("emits Korea and Korea realistic as separate KO-guarded functions", () => {
    const urls: UrlMap = {
      Korea: { email: { default: "https://cdn/kr.png", KO: null } },
      "Korea realistic": { email: { default: "https://cdn/kr-real.png", KO: null } },
      corgibet: { email: { default: "https://cdn/corgi.png", KO: null } },
    };
    const blocks = generateOutputs(
      urls,
      ["email"],
      [nb("Korea"), nb("Korea realistic"), nb("corgibet")],
    );
    const titles = blocks.map((b) => b.title);
    expect(titles).toContain("Email — Korea (KO)");
    expect(titles).toContain("Email — Korea realistic (KO)");

    const korea = blocks.find((b) => b.title === "Email — Korea (KO)")!;
    expect(korea.kind).toBe("function");
    expect(korea.code).toContain("var language = state.core_user_language;");
    expect(korea.code).toContain('if (language === "KO")');
    expect(korea.code).toContain('return "https://cdn/kr.png";');
    expect(korea.code).toContain("{{label.dynamic_image_default_unique}}");

    const realistic = blocks.find((b) => b.title === "Email — Korea realistic (KO)")!;
    expect(realistic.code).toContain('return "https://cdn/kr-real.png";');

    // Korea must not leak into the individual-brand function
    const fn = blocks.find((b) => b.title === "Email — Function")!;
    expect(fn.code).not.toContain("https://cdn/kr.png");
    expect(fn.code).not.toContain("Korea");
  });

  it("Korea function falls back to the All brands image when present", () => {
    const urls: UrlMap = {
      Korea: { email: { default: "https://cdn/kr.png", KO: null } },
      corgibet: { email: { default: "https://cdn/corgi.png", KO: null } },
    };
    const blocks = generateOutputs(urls, ["email"], [nb("Korea"), nb("corgibet")], "https://cdn/default.png");
    const korea = blocks.find((b) => b.title === "Email — Korea (KO)")!;
    expect(korea.code).toContain('return "https://cdn/default.png";');
    expect(korea.code).not.toContain("{{label.dynamic_image_default_unique}}");
  });

  it("keeps a brand with only a Korean image as a plain default string", () => {
    const urls: UrlMap = {
      corgibet: { email: { default: null, KO: "https://cdn/ko-only.png" } },
    };
    const blocks = generateOutputs(urls, ["email"], [nb("corgibet")]);
    expect(blocks[0]!.code).toContain('"Corgibet": "https://cdn/ko-only.png"');
    expect(blocks[0]!.code).not.toContain("core_user_language");
  });

  it("omits a type entirely when no brand produced a URL", () => {
    const urls: UrlMap = { corgibet: { email: { default: null, KO: null } } };
    const blocks = generateOutputs(urls, ["email"], [nb("corgibet")]);
    expect(blocks).toHaveLength(0);
  });
});

describe("generateSmarticoCardOutputs (Tournament card.webp)", () => {
  it("builds one multi-brand card function with canonical keys and no localization", () => {
    const cardUrls = {
      brunocasino: "https://cdn/c/bruno.png",
      corgibet: "https://cdn/c/corgi.png",
    };
    const blocks = generateSmarticoCardOutputs(cardUrls, [nb("brunocasino"), nb("corgibet")]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.title).toBe("Smartico — Card");
    expect(blocks[0]!.kind).toBe("function");
    expect(blocks[0]!.code).toContain('"BrunoCasino": "https://cdn/c/bruno.png"');
    expect(blocks[0]!.code).toContain('"Corgibet": "https://cdn/c/corgi.png"');
    expect(blocks[0]!.code).toContain("state.core_sm_brand_id");
    expect(blocks[0]!.code).not.toContain("core_user_language"); // card has no KO
  });

  it("uses the All brands card as the else-fallback of the card function", () => {
    const cardUrls = {
      "All brands": "https://cdn/c/all.png",
      corgibet: "https://cdn/c/corgi.png",
    };
    const blocks = generateSmarticoCardOutputs(cardUrls, [nb("All brands"), nb("corgibet")]);
    expect(blocks).toHaveLength(1);
    const fn = blocks[0]!;
    expect(fn.title).toBe("Smartico — Card");
    expect(fn.code).toContain('"Corgibet": "https://cdn/c/corgi.png"');
    expect(fn.code).toContain('return "https://cdn/c/all.png";');
    expect(fn.code).not.toContain("{{label.dynamic_image_default_unique}}");
  });

  it("emits the constant Сквозной card function when only All brands is present", () => {
    const blocks = generateSmarticoCardOutputs(
      { "All brands": "https://cdn/c/all.png" },
      [nb("All brands")],
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.title).toBe("Smartico — All Brands (Сквозной)");
    expect(blocks[0]!.code).toContain('return "https://cdn/c/all.png";');
  });

  it("emits Korea as a KO-guarded Smartico function", () => {
    const cardUrls = { Korea: "https://cdn/c/kr.png", corgibet: "https://cdn/c/corgi.png" };
    const blocks = generateSmarticoCardOutputs(cardUrls, [nb("Korea"), nb("corgibet")]);
    const korea = blocks.find((b) => b.title === "Smartico — Korea (KO)")!;
    expect(korea.kind).toBe("function");
    expect(korea.code).toContain("var language = state.core_user_language;");
    expect(korea.code).toContain('if (language === "KO")');
    expect(korea.code).toContain('return "https://cdn/c/kr.png";');
  });

  it("returns no blocks when no brand produced a card URL", () => {
    expect(generateSmarticoCardOutputs({ corgibet: null }, [nb("corgibet")])).toHaveLength(0);
  });
});
