import { describe, it, expect } from "vitest";
import {
  parseStructure,
  availableTypes,
  resolveEntry,
  typeFromFolder,
  typeFromFilename,
  isUnsafePath,
  isAllBrands,
  buildBrandMap,
  normalizeBrand,
} from "../src/lib/smartico/detect.js";

describe("typeFromFolder", () => {
  it("maps clean leaf folders to canonical types", () => {
    expect(typeFromFolder("email")).toBe("email");
    expect(typeFromFolder("Push")).toBe("push");
    expect(typeFromFolder("pop-up_1")).toBe("pop-up_1");
    expect(typeFromFolder("popup2")).toBe("pop-up_2");
    expect(typeFromFolder("pop-up")).toBe("pop-up");
  });
  it("ignores subitem and unknown folders", () => {
    expect(typeFromFolder("subitem")).toBeNull();
    expect(typeFromFolder("content")).toBeNull();
    expect(typeFromFolder("banner xxxl")).toBeNull();
  });
});

describe("typeFromFilename (legacy token rule)", () => {
  it("detects a type token anywhere in the name", () => {
    expect(typeFromFilename("corgibet email 600x266.webp")).toBe("email");
    expect(typeFromFilename("img_push_kr.png")).toBe("push");
    expect(typeFromFilename("brand pop-up 1080x1920.jpg")).toBe("pop-up");
    expect(typeFromFilename("promo pop-up_1.png")).toBe("pop-up_1");
  });
  it("returns null when no token present", () => {
    expect(typeFromFilename("promocard.png")).toBeNull();
    expect(typeFromFilename("subitem_thing.png")).toBeNull();
  });
});

describe("resolveEntry — new (CRM) structure", () => {
  it("reads brand two levels above CRM and type from the leaf folder", () => {
    expect(resolveEntry("Nine/Summer Cup/CRM/email/banner.webp")).toEqual({
      brand: "Nine",
      type: "email",
    });
    expect(resolveEntry("Nine/Summer Cup/CRM/pop-up_2/x.png")).toEqual({
      brand: "Nine",
      type: "pop-up_2",
    });
  });
  it("ignores CONTENT/SMARTICO siblings and subitem", () => {
    expect(resolveEntry("Nine/Summer Cup/CONTENT/promocard.png")).toBeNull();
    expect(resolveEntry("Nine/Summer Cup/SMARTICO/promo smartico.png")).toBeNull();
    expect(resolveEntry("Nine/Summer Cup/CRM/subitem/x.png")).toBeNull();
  });
  it("supports a wrapper folder above the brand (Tournament/Mailing)", () => {
    expect(resolveEntry("РАССЫЛКА/Nine/Promo/CRM/push/p.png")).toEqual({
      brand: "Nine",
      type: "push",
    });
  });
  it("falls back to filename token when CRM has no type subfolder", () => {
    expect(resolveEntry("Nine/Promo/CRM/nine email.png")).toEqual({
      brand: "Nine",
      type: "email",
    });
  });
});

describe("resolveEntry — legacy structure", () => {
  it("reads DES-XXXXX / Brand / file with filename token", () => {
    expect(resolveEntry("DES-12345/Corgibet/corgibet email 600x266.webp")).toEqual({
      brand: "Corgibet",
      type: "email",
    });
  });
  it("honors the Oscar brands wrapper and ignores siblings depth", () => {
    expect(resolveEntry("DES-12345/Oscar brands/Corgibet/push.png")).toEqual({
      brand: "Corgibet",
      type: "push",
    });
  });
});

describe("parseStructure", () => {
  const paths = [
    "Nine/Summer/CRM/email/a.png",
    "Nine/Summer/CRM/push/b.png",
    "Nine/Summer/CRM/email/korean/a_korean.png",
    "Nine/Summer/CONTENT/promocard.png",
    "All brands/Summer/CRM/pop-up_1/all.png",
    "__MACOSX/Nine/._a.png",
    "Nine/Summer/CRM/email/.DS_Store",
  ];
  const structure = parseStructure(paths);

  it("collects brands with their type slots and locales", () => {
    expect(Object.keys(structure.brands).sort()).toEqual(["All brands", "Nine"]);
    expect(structure.brands["Nine"]!.email).toEqual({
      default: "Nine/Summer/CRM/email/a.png",
      KO: "Nine/Summer/CRM/email/korean/a_korean.png",
    });
    expect(structure.brands["Nine"]!.push!.default).toBe("Nine/Summer/CRM/push/b.png");
  });
  it("skips junk and non-content entries", () => {
    expect(structure.brands["Nine"]!.email!.default).not.toContain("__MACOSX");
    // CONTENT promocard contributed no type
    expect(Object.keys(structure.brands["Nine"]!)).not.toContain("content");
  });
  it("computes available types in canonical order", () => {
    expect(availableTypes(structure)).toEqual(["email", "push", "pop-up_1"]);
  });
});

describe("isUnsafePath (zip-slip guard)", () => {
  it("flags traversal and absolute paths", () => {
    expect(isUnsafePath("../etc/passwd")).toBe(true);
    expect(isUnsafePath("a/../../b")).toBe(true);
    expect(isUnsafePath("/abs/path")).toBe(true);
    expect(isUnsafePath("C:\\win")).toBe(true);
    expect(isUnsafePath("Nine/Summer/CRM/email/a.png")).toBe(false);
  });
});

describe("brand normalization", () => {
  const map = buildBrandMap(["BrunoCasino", "God of Coins", "Corgibet"]);

  it("matches case- and space-insensitively to the canonical name", () => {
    expect(normalizeBrand("brunocasino", map).canonical).toBe("BrunoCasino");
    expect(normalizeBrand("god of coins", map).canonical).toBe("God of Coins");
    expect(normalizeBrand("CORGIBET", map).matched).toBe(true);
  });
  it("flags unknown brands as suspicious but keeps them", () => {
    const nb = normalizeBrand("UnknownBrand", map);
    expect(nb.matched).toBe(false);
    expect(nb.suspicious).toBe(true);
    expect(nb.canonical).toBe("UnknownBrand");
  });
  it("treats All brands as a non-suspicious label case", () => {
    expect(isAllBrands("All brands")).toBe(true);
    const nb = normalizeBrand("All brands", map);
    expect(nb.isAllBrands).toBe(true);
    expect(nb.suspicious).toBe(false);
  });
});
