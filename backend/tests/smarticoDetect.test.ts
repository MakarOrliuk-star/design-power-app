import { describe, it, expect } from "vitest";
import {
  parseStructure,
  availableTypes,
  resolveEntry,
  typeFromFolder,
  typeFromFilename,
  isUnsafePath,
  isAllBrands,
  koreaVariantOf,
  buildBrandMap,
  normalizeBrand,
} from "../src/lib/smartico/detect.js";

describe("typeFromFolder", () => {
  it("maps clean leaf folders to canonical types", () => {
    expect(typeFromFolder("email")).toBe("email");
    expect(typeFromFolder("Push")).toBe("push");
    expect(typeFromFolder("pop-up_1")).toBe("pop-up_1");
    expect(typeFromFolder("popup2")).toBe("pop-up_2");
    // Plain pop-up is an alias of the default pop-up_1 (Smartico naming).
    expect(typeFromFolder("pop-up")).toBe("pop-up_1");
  });
  it("ignores subitem and unknown folders", () => {
    expect(typeFromFolder("subitem")).toBeNull();
    expect(typeFromFolder("content")).toBeNull();
    expect(typeFromFolder("banner xxxl")).toBeNull();
  });
});

describe("typeFromFilename (token rule)", () => {
  it("detects a type token anywhere in the name", () => {
    expect(typeFromFilename("corgibet email 600x266.webp")).toBe("email");
    expect(typeFromFilename("img_push_kr.png")).toBe("push");
    expect(typeFromFilename("brand pop-up 1080x1920.jpg")).toBe("pop-up_1");
    expect(typeFromFilename("promo pop-up_1.png")).toBe("pop-up_1");
    expect(typeFromFilename("pop-up_1 .webp")).toBe("pop-up_1"); // trailing space
    expect(typeFromFilename("pop-up_2.webp")).toBe("pop-up_2");
  });
  it("ignores email_text so it doesn't shadow the real email image", () => {
    expect(typeFromFilename("email_text.webp")).toBeNull();
    expect(typeFromFilename("email text.webp")).toBeNull();
    expect(typeFromFilename("email.webp")).toBe("email");
  });
  it("returns null when no token present", () => {
    expect(typeFromFilename("promocard.png")).toBeNull();
    expect(typeFromFilename("subitem_thing.png")).toBeNull();
  });
});

describe("resolveEntry — new (CRM) structure: DES-XXXXX / Brand / CRM / file", () => {
  it("reads the brand one level above CRM, type from the filename", () => {
    expect(resolveEntry("DES-10001/Bonuskong/CRM/email.webp")).toEqual({
      brand: "Bonuskong",
      type: "email",
    });
    expect(resolveEntry("DES-10001/Bonuskong/CRM/pop-up_1 .webp")).toEqual({
      brand: "Bonuskong",
      type: "pop-up_1",
    });
    expect(resolveEntry("DES-10001/Bonuskong/CRM/pop-up_2.webp")).toEqual({
      brand: "Bonuskong",
      type: "pop-up_2",
    });
    expect(resolveEntry("DES-10001/Bonuskong/CRM/push.webp")).toEqual({
      brand: "Bonuskong",
      type: "push",
    });
  });
  it("classifies Korea / All brands as same-level pseudo-brands", () => {
    expect(resolveEntry("DES-10002/Korea/CRM/email.webp")).toEqual({
      brand: "Korea",
      type: "email",
    });
    expect(resolveEntry("DES-10002/Korea realistic/CRM/push.webp")).toEqual({
      brand: "Korea realistic",
      type: "push",
    });
    expect(resolveEntry("DES-10001/All brands/CRM/pop-up_1.webp")).toEqual({
      brand: "All brands",
      type: "pop-up_1",
    });
  });
  it("ignores email_text, subitem, and CONTENT/SMARTICO siblings", () => {
    expect(resolveEntry("DES-10001/Bonuskong/CRM/email_text.webp")).toBeNull();
    expect(resolveEntry("DES-10001/Bonuskong/CRM/subitem.webp")).toBeNull();
    expect(resolveEntry("DES-10002/Bonuskong/CONTENT/banner xxxl.webp")).toBeNull();
    expect(resolveEntry("DES-10002/Bonuskong/SMARTICO/promo smartico.webp")).toBeNull();
  });
  it("still supports an optional type subfolder under CRM (fallback)", () => {
    expect(resolveEntry("DES-10001/Bonuskong/CRM/email/banner.webp")).toEqual({
      brand: "Bonuskong",
      type: "email",
    });
    expect(resolveEntry("DES-10001/Bonuskong/CRM/subitem/x.png")).toBeNull();
  });
});

describe("resolveEntry — root-brand structure: [DES-123/]Brand/<channel>/file", () => {
  it("reads brand folders directly at the archive root", () => {
    expect(resolveEntry("NineCasino/email/promo.png")).toEqual({
      brand: "NineCasino",
      type: "email",
    });
    expect(resolveEntry("NineCasino/push/promo.webp")).toEqual({
      brand: "NineCasino",
      type: "push",
    });
    // Plain pop-up folder maps to the default pop-up_1 (Smartico naming).
    expect(resolveEntry("NineCasino/pop-up/promo.jpg")).toEqual({
      brand: "NineCasino",
      type: "pop-up_1",
    });
  });
  it("honors a single wrapper folder above the brands", () => {
    expect(resolveEntry("DES-123/NineCasino/email/promo.png")).toEqual({
      brand: "NineCasino",
      type: "email",
    });
  });
  it("is case-insensitive on channel folder names", () => {
    expect(resolveEntry("NineCasino/Email/promo.png")).toEqual({
      brand: "NineCasino",
      type: "email",
    });
    expect(resolveEntry("NineCasino/Pop-Up/promo.png")).toEqual({
      brand: "NineCasino",
      type: "pop-up_1",
    });
  });
  it("no longer invents channel-named brands (the old mis-parse bug)", () => {
    // Before the fix this resolved to { brand: "push", type: "push" }.
    expect(resolveEntry("NineCasino/push/nine push.png")).toEqual({
      brand: "NineCasino",
      type: "push",
    });
  });
  it("ignores non-image files in channel folders", () => {
    expect(resolveEntry("NineCasino/email/readme.txt")).toBeNull();
  });
  it("does not clash with the CRM and Oscar structures", () => {
    expect(resolveEntry("DES-10001/Bonuskong/CRM/email/banner.webp")).toEqual({
      brand: "Bonuskong",
      type: "email",
    });
    expect(resolveEntry("DES-12345/Oscar brands/Corgibet/push/img.png")).toEqual({
      brand: "Corgibet",
      type: "push",
    });
  });
});

describe("resolveEntry — legacy structure (retained as fallback)", () => {
  it("reads DES-XXXXX / Brand / file with filename token", () => {
    expect(resolveEntry("DES-12345/Corgibet/corgibet email 600x266.webp")).toEqual({
      brand: "Corgibet",
      type: "email",
    });
  });
  it("honors the Oscar brands wrapper", () => {
    expect(resolveEntry("DES-12345/Oscar brands/Corgibet/push.png")).toEqual({
      brand: "Corgibet",
      type: "push",
    });
  });
  it("maps a legacy *korean* filename to the KO locale slot", () => {
    expect(resolveEntry("DES-12345/Corgibet/corgibet email korean.webp")).toEqual({
      brand: "Corgibet",
      type: "email",
    });
  });
});

describe("parseStructure", () => {
  const paths = [
    "DES-10001/Bonuskong/CRM/email.webp",
    "DES-10001/Bonuskong/CRM/push.webp",
    "DES-10001/Bonuskong/CRM/email_text.webp", // ignored
    "DES-10001/Bonuskong/CRM/subitem.webp", // ignored
    "DES-10001/All brands/CRM/pop-up_1 .webp",
    "DES-10002/Korea/CRM/email.webp",
    "DES-10002/Bonuskong/CONTENT/banner xxxl.webp", // ignored (not CRM)
    "__MACOSX/DES-10001/._a.png",
    "DES-10001/Bonuskong/CRM/.DS_Store",
  ];
  const structure = parseStructure(paths);

  it("collects brands (incl. pseudo-brands) with their type slots", () => {
    expect(Object.keys(structure.brands).sort()).toEqual([
      "All brands",
      "Bonuskong",
      "Korea",
    ]);
    expect(structure.brands["Bonuskong"]!.email).toEqual({
      default: "DES-10001/Bonuskong/CRM/email.webp",
      KO: null,
    });
    expect(structure.brands["Bonuskong"]!.push!.default).toBe(
      "DES-10001/Bonuskong/CRM/push.webp",
    );
    expect(structure.brands["Korea"]!.email!.default).toBe("DES-10002/Korea/CRM/email.webp");
  });
  it("skips junk, email_text, subitem and non-CRM entries", () => {
    expect(Object.keys(structure.brands["Bonuskong"]!).sort()).toEqual(["email", "push"]);
  });
  it("computes available types in canonical order", () => {
    expect(availableTypes(structure)).toEqual(["email", "push", "pop-up_1"]);
  });
  it("has no All brands default image in the CRM structure", () => {
    expect(structure.allBrandsDefault).toBeNull();
  });
});

describe("parseStructure — root-brand structure + All brands default", () => {
  const paths = [
    "DES-123/NineCasino/email/a-promo.png",
    "DES-123/NineCasino/email/b-promo.png", // duplicate slot → alphabetically first wins
    "DES-123/NineCasino/push/promo.png",
    "DES-123/BrunoCasino/pop-up/promo.webp",
    "DES-123/NineCasino/pop-up/readme.txt", // not an image → ignored
    "DES-123/All brands/main.png", // type-less default image
    "DES-123/All brands/zzz.png", // second candidate → loses alphabetically
    "__MACOSX/DES-123/NineCasino/email/._a-promo.png",
    "DES-123/NineCasino/email/.DS_Store",
  ];
  const structure = parseStructure(paths);

  it("collects brands from root-level folders with channel subfolders", () => {
    expect(Object.keys(structure.brands).sort()).toEqual(["BrunoCasino", "NineCasino"]);
    expect(structure.brands["NineCasino"]!.push!.default).toBe("DES-123/NineCasino/push/promo.png");
    expect(structure.brands["BrunoCasino"]!["pop-up_1"]!.default).toBe(
      "DES-123/BrunoCasino/pop-up/promo.webp",
    );
  });
  it("keeps the alphabetically first image when a channel folder has several", () => {
    expect(structure.brands["NineCasino"]!.email!.default).toBe(
      "DES-123/NineCasino/email/a-promo.png",
    );
  });
  it("captures the alphabetically first All brands default image", () => {
    expect(structure.allBrandsDefault).toBe("DES-123/All brands/main.png");
  });
  it("skips non-image files so they never win a slot", () => {
    expect(structure.brands["NineCasino"]!["pop-up_1"]).toBeUndefined();
  });
  it("also detects the default image without a wrapper folder", () => {
    const s = parseStructure(["All brands/main.png", "NineCasino/email/promo.png"]);
    expect(s.allBrandsDefault).toBe("All brands/main.png");
    expect(s.brands["NineCasino"]!.email!.default).toBe("NineCasino/email/promo.png");
  });
  it("keeps per-type All brands entries out of the default", () => {
    const s = parseStructure([
      "DES-1/All brands/CRM/pop-up_1.webp", // CRM per-type
      "DES-1/All brands/all email.png", // legacy filename token per-type
    ]);
    expect(s.allBrandsDefault).toBeNull();
    expect(s.brands["All brands"]!["pop-up_1"]!.default).toBe("DES-1/All brands/CRM/pop-up_1.webp");
    expect(s.brands["All brands"]!.email!.default).toBe("DES-1/All brands/all email.png");
  });
});

describe("isUnsafePath (zip-slip guard)", () => {
  it("flags traversal and absolute paths", () => {
    expect(isUnsafePath("../etc/passwd")).toBe(true);
    expect(isUnsafePath("a/../../b")).toBe(true);
    expect(isUnsafePath("/abs/path")).toBe(true);
    expect(isUnsafePath("C:\\win")).toBe(true);
    expect(isUnsafePath("DES-10001/Bonuskong/CRM/email.webp")).toBe(false);
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
  it("treats All brands as a non-suspicious cross-brand case", () => {
    expect(isAllBrands("All brands")).toBe(true);
    const nb = normalizeBrand("All brands", map);
    expect(nb.isAllBrands).toBe(true);
    expect(nb.suspicious).toBe(false);
    expect(nb.isKorea).toBe(false);
  });
  it("classifies Korea / Korea realistic as KO pseudo-brands (not suspicious)", () => {
    expect(koreaVariantOf("Korea")).toBe("standard");
    expect(koreaVariantOf("Korea realistic")).toBe("realistic");
    expect(koreaVariantOf("Bonuskong")).toBeNull();

    const korea = normalizeBrand("Korea", map);
    expect(korea.isKorea).toBe(true);
    expect(korea.koreaVariant).toBe("standard");
    expect(korea.suspicious).toBe(false);

    const realistic = normalizeBrand("Korea realistic", map);
    expect(realistic.isKorea).toBe(true);
    expect(realistic.koreaVariant).toBe("realistic");
    expect(realistic.suspicious).toBe(false);
  });
});
