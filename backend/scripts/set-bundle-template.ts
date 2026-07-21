import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/prisma.js";
import { uploadBuffer } from "../src/lib/cloudinary.js";

/**
 * Upload a layout template background for an Image Bundles asset type (D13)
 * and store its URL in BundleType.assets[].templateUrl. The pipeline then
 * feeds it to nano-banana as the FIRST reference — the model copies its
 * composition zones (person right / items left / empty center for email).
 *
 * Dry-run by default; pass --apply to write. Needs DATABASE_URL + Cloudinary
 * creds in the environment (same as the seed scripts / Railway workflow).
 *
 * Usage:
 *   npx tsx scripts/set-bundle-template.ts "<path to image>" <assetKey> [typeKey] [--apply]
 * Example:
 *   npx tsx scripts/set-bundle-template.ts "../figma/crm-bundle/example email.webp" email simple_sendout --apply
 */

interface TypeAsset {
  key: string;
  label: string;
  width: number;
  height: number;
  templateUrl?: string;
  zones?: Record<string, { x: number; y: number; w: number; h: number }>;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--apply");
  const apply = process.argv.includes("--apply");
  const [filePath, assetKey, typeKey = "simple_sendout"] = args;
  if (!filePath || !assetKey) {
    console.error(
      'Usage: npx tsx scripts/set-bundle-template.ts "<path to image>" <assetKey: email|popup|push> [typeKey] [--apply]',
    );
    process.exit(1);
  }

  const type = await prisma.bundleType.findUnique({ where: { key: typeKey } });
  if (!type) throw new Error(`BundleType "${typeKey}" not found — run the seed first`);

  const assets = type.assets as unknown as TypeAsset[];
  const slot = assets.find((a) => a.key === assetKey);
  if (!slot) throw new Error(`Asset key "${assetKey}" not in type "${typeKey}" (${assets.map((a) => a.key).join(", ")})`);

  const buffer = await readFile(path.resolve(filePath));
  console.log(`Template for ${typeKey}/${assetKey} ← ${filePath} (${(buffer.length / 1024).toFixed(0)} KB)`);
  if (!apply) {
    console.log("DRY RUN — pass --apply to upload and save.");
    return;
  }

  const up = await uploadBuffer(buffer, `template_${assetKey}`, "bundles/templates", true);
  if (!up.success || !up.secure_url) throw new Error(`Cloudinary upload failed: ${up.error}`);
  console.log(`Uploaded: ${up.secure_url}`);

  slot.templateUrl = up.secure_url;
  await prisma.bundleType.update({
    where: { id: type.id },
    data: { assets: assets as unknown as object },
  });
  console.log(`✅ BundleType "${typeKey}" updated — ${assetKey}.templateUrl set.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error("❌", e);
    await prisma.$disconnect();
    process.exit(1);
  });
