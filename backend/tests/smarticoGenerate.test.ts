import { describe, it, expect } from "vitest";
import { generateOutputs, type UrlMap } from "../src/lib/smartico/generate.js";
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

  it("renders All brands as a single-URL label, not a function", () => {
    const urls: UrlMap = {
      "All brands": { email: { default: "https://cdn/all.png", KO: null } },
      corgibet: { email: { default: "https://cdn/corgi.png", KO: null } },
    };
    const blocks = generateOutputs(urls, ["email"], [nb("All brands"), nb("corgibet")]);
    const label = blocks.find((b) => b.kind === "label");
    const fn = blocks.find((b) => b.kind === "function");
    expect(label?.title).toBe("Email — All Brands (Label)");
    expect(label?.code).toContain("Create a label with this image URL:");
    expect(label?.code).toContain("https://cdn/all.png");
    // the All-brands key must not leak into the individual-brand function
    expect(fn?.code).not.toContain("https://cdn/all.png");
    expect(fn?.code).toContain('"Corgibet": "https://cdn/corgi.png"');
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
