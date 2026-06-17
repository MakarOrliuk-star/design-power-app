import type { TypeKey, NormalizedBrand } from "./detect.js";

export interface UrlSlot {
  default: string | null;
  KO: string | null;
}
export type UrlMap = Record<string, Partial<Record<TypeKey, UrlSlot>>>;

export interface OutputBlock {
  title: string;
  code: string;
  kind: "function" | "label";
}

const FALLBACK = '{{label.dynamic_image_default_unique}}';

const DISPLAY: Record<TypeKey, string> = {
  email: "Email",
  push: "Push",
  "pop-up": "Pop-up",
  "pop-up_1": "Pop-up 1",
  "pop-up_2": "Pop-up 2",
};

function buildFunction(entries: string[], hasLocalization: boolean, displayType: string): string {
  const subjectLineContent = entries.join(",\n");

  let output = "(function() {\n";
  output += "    // Importing the necessary Java classes\n";
  output += "    Date = Java.type('java.util.Date');\n";
  output += "    Int = Java.type('java.lang.Integer');\n";
  output += "    Math = Java.type('java.lang.Math');\n";
  output += "\n";
  output += `    // Image URLs for each brand (${displayType})\n`;
  output += "    var subjectLine = {\n";
  output += subjectLineContent + "\n";
  output += "    };\n";
  output += "\n";
  if (hasLocalization) {
    output += "    // Get the current brand_id and user language\n";
    output += "    var brand_id = state.core_sm_brand_id;\n";
    output += "    var language = state.core_user_language;\n";
    output += "\n";
    output += "    // Return image URL for this brand (locale-aware)\n";
    output += "    if (subjectLine[brand_id]) {\n";
    output += "        var entry = subjectLine[brand_id];\n";
    output += '        if (typeof entry === "object" && entry !== null) {\n';
    output += `            return entry[language] || entry["default"] || "${FALLBACK}";\n`;
    output += "        }\n";
    output += "        return entry;\n";
    output += "    } else {\n";
    output += `        return "${FALLBACK}";\n`;
    output += "    }\n";
  } else {
    output += "    // Get the current brand_id\n";
    output += "    var brand_id = state.core_sm_brand_id;\n";
    output += "\n";
    output += "    // Return image URL for this brand\n";
    output += "    if (subjectLine[brand_id]) {\n";
    output += "        return subjectLine[brand_id];\n";
    output += "    } else {\n";
    output += `        return "${FALLBACK}";\n`;
    output += "    }\n";
  }
  output += "})();";
  return output;
}

export function generateOutputs(
  urls: UrlMap,
  selectedTypes: TypeKey[],
  brands: NormalizedBrand[],
): OutputBlock[] {
  // Map raw brand → canonical name, and split off the "All brands" label case.
  const canonicalByRaw = new Map<string, string>();
  let allBrandsRaw: string | null = null;
  const individualRaws: string[] = [];
  for (const b of brands) {
    canonicalByRaw.set(b.raw, b.canonical);
    if (b.isAllBrands) allBrandsRaw = b.raw;
    else individualRaws.push(b.raw);
  }

  const blocks: OutputBlock[] = [];

  for (const type of selectedTypes) {
    const displayType = DISPLAY[type] ?? type;

    // Case 1: "All brands" — a single shared URL shown as a label.
    if (allBrandsRaw) {
      const slot = urls[allBrandsRaw]?.[type];
      const allUrl = slot ? slot.default || slot.KO : null;
      if (allUrl) {
        blocks.push({
          title: `${displayType} — All Brands (Label)`,
          code: `Create a label with this image URL:\n${allUrl}`,
          kind: "label",
        });
      }
    }

    // Case 2: individual brands — one Smartico function.
    const entries: string[] = [];
    let hasLocalization = false;
    for (const raw of individualRaws) {
      const slot = urls[raw]?.[type];
      if (!slot) continue;
      const canonical = canonicalByRaw.get(raw) ?? raw;
      const defaultUrl = slot.default;
      const koUrl = slot.KO;

      if (defaultUrl && koUrl) {
        hasLocalization = true;
        entries.push(
          `        "${canonical}": {\n` +
            `            "default": "${defaultUrl}",\n` +
            `            "KO": "${koUrl}"\n` +
            `        }`,
        );
      } else if (defaultUrl) {
        entries.push(`        "${canonical}": "${defaultUrl}"`);
      } else if (koUrl) {
        // Brand has only a Korean image — treat it as the default string.
        entries.push(`        "${canonical}": "${koUrl}"`);
      }
    }

    if (entries.length > 0) {
      blocks.push({
        title: `${displayType} — Function`,
        code: buildFunction(entries, hasLocalization, displayType),
        kind: "function",
      });
    }
  }

  return blocks;
}
