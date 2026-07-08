import type { Job } from "bullmq";
import { prisma } from "../lib/prisma.js";
import { getDriveToken } from "../lib/driveTokens.js";
import {
  listFolderChildren,
  downloadDriveFile,
  findChildFolder,
  findChildFile,
  DriveApiError,
} from "../lib/drive.js";
import {
  buildBrandMap,
  normalizeBrand,
  type TypeKey,
} from "../lib/smartico/detect.js";
import { generateOutputs, generateSmarticoCardOutputs } from "../lib/smartico/generate.js";
import { uploadSmarticoAsset } from "../lib/smartico/uploadAsset.js";
import type { SmarticoJobResult, SmarticoUrlSlot } from "./smartico.processor.js";
import type { DriveSmarticoJobData } from "./index.js";

/**
 * Google Drive generation: the user picked ONE event folder (e.g. "Tournament
 * Summer VIP"). Every brand under the branch shares the same event/folder
 * structure, so we walk each brand → <event> → CRM → <type>.webp, upload each
 * image (de-duped) to Cloudinary, then build the same multi-brand Smartico
 * functions as the ZIP flow. Reads Drive with the user's own token.
 */

const BRAND_CONCURRENCY = 5;
const CRM_FOLDER = "CRM";
// Tournament-only sibling of CRM holding a single card image (TASK D3).
const SMARTICO_FOLDER = "SMARTICO";
const CARD_FILENAME = "card.webp";

// The CRM folder always holds exactly these filenames (guaranteed by the team).
const DRIVE_FILENAME: Partial<Record<TypeKey, string>> = {
  email: "email.webp",
  "pop-up": "pop-up.webp",
  push: "push.webp",
};

/** A 401/403 from Drive means the token died — fail the whole job, not one brand. */
function isFatalDriveError(e: unknown): boolean {
  return e instanceof DriveApiError && (e.status === 401 || e.status === 403);
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await fn(item);
    }
  });
  await Promise.all(runners);
}

export async function processDriveSmarticoJob(
  job: Job<DriveSmarticoJobData>,
): Promise<SmarticoJobResult> {
  const { userId, branchId, eventName, packName } = job.data;
  const selectedTypes = job.data.selectedTypes as TypeKey[];
  const includeSmartico = job.data.includeSmartico === true;

  const token = await getDriveToken(userId);
  if (!token) throw new Error("drive_not_connected");

  const brandFolders = (await listFolderChildren(token, branchId)).filter((f) => f.isFolder);
  const total = brandFolders.length;

  const rows = await prisma.smarticoBrand.findMany({ select: { name: true } });
  const brandMap = buildBrandMap(rows.map((r) => r.name));

  const urls: Record<string, Partial<Record<TypeKey, SmarticoUrlSlot>>> = {};
  const cardUrls: Record<string, string | null> = {}; // raw brand → card.webp URL
  const failedItems: string[] = [];
  let uploaded = 0;
  let reused = 0;
  let failed = 0;
  let processed = 0;

  const setUrl = (brand: string, type: TypeKey, url: string | null) => {
    const b = (urls[brand] ??= {});
    const slot = (b[type] ??= { default: null, KO: null });
    slot.default = url;
  };

  await mapPool(brandFolders, BRAND_CONCURRENCY, async (brandFolder) => {
    const rawBrand = brandFolder.name.trim();
    try {
      // brand → <event> → { CRM, SMARTICO }
      const eventFolder = findChildFolder(
        await listFolderChildren(token, brandFolder.id),
        eventName,
      );
      if (!eventFolder) return; // this brand doesn't have the chosen event
      const eventChildren = await listFolderChildren(token, eventFolder.id);

      // ---- CRM: one image per selected type (default folder of the event) ----
      const crmFolder = findChildFolder(eventChildren, CRM_FOLDER);
      if (crmFolder) {
        const crmFiles = await listFolderChildren(token, crmFolder.id);
        for (const type of selectedTypes) {
          const filename = DRIVE_FILENAME[type];
          if (!filename) continue;
          const file = findChildFile(crmFiles, filename);
          if (!file) continue;

          const label = `${rawBrand}/${type}`;
          try {
            const buffer = await downloadDriveFile(token, file.id);
            const outcome = await uploadSmarticoAsset(buffer, {
              namespace: packName,
              brand: rawBrand,
              type,
              locale: "default",
            });
            setUrl(rawBrand, type, outcome.url);
            if (outcome.status === "uploaded") uploaded++;
            else if (outcome.status === "reused") reused++;
            else {
              failed++;
              failedItems.push(label);
            }
          } catch (e) {
            if (isFatalDriveError(e)) throw e;
            failed++;
            failedItems.push(label);
            console.error(`⚠️ Drive image error for ${label}:`, e);
          }
        }
      }

      // ---- SMARTICO: a single card.webp (Tournament only, opt-in) ----
      if (includeSmartico) {
        const smFolder = findChildFolder(eventChildren, SMARTICO_FOLDER);
        const smFile = smFolder
          ? findChildFile(await listFolderChildren(token, smFolder.id), CARD_FILENAME)
          : undefined;
        if (smFile) {
          const label = `${rawBrand}/card`;
          try {
            const buffer = await downloadDriveFile(token, smFile.id);
            const outcome = await uploadSmarticoAsset(buffer, {
              namespace: packName,
              brand: rawBrand,
              type: "card",
              locale: "default",
            });
            cardUrls[rawBrand] = outcome.url;
            if (outcome.status === "uploaded") uploaded++;
            else if (outcome.status === "reused") reused++;
            else {
              failed++;
              failedItems.push(label);
            }
          } catch (e) {
            if (isFatalDriveError(e)) throw e;
            failed++;
            failedItems.push(label);
            console.error(`⚠️ Drive image error for ${label}:`, e);
          }
        }
      }
    } catch (e) {
      if (isFatalDriveError(e)) throw e; // propagate → fail the job (reconnect Drive)
      failed++;
      failedItems.push(rawBrand);
      console.error(`⚠️ Drive brand error for ${rawBrand}:`, e);
    } finally {
      processed++;
      await job.updateProgress(Math.min(99, Math.round((processed / Math.max(1, total)) * 100)));
    }
  });

  // Brands seen via CRM and/or the Smartico card folder (a brand may have only one).
  const rawBrands = Array.from(new Set([...Object.keys(urls), ...Object.keys(cardUrls)]));
  const brands = rawBrands.map((raw) => normalizeBrand(raw, brandMap));
  const outputs = generateOutputs(urls, selectedTypes, brands);
  if (includeSmartico) {
    outputs.push(...generateSmarticoCardOutputs(cardUrls, brands));
  }

  await job.updateProgress(100);
  return {
    zipName: packName,
    selectedTypes,
    urls,
    brands,
    allBrandsDefaultUrl: null, // Drive flow has no type-less "All brands" default image
    outputs,
    stats: { total: uploaded + reused + failed, uploaded, reused, failed, failedItems },
  };
}
