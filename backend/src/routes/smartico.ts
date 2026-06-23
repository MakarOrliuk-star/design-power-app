import { Router } from "express";
import type { Request, Response } from "express";
import { rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { z } from "zod";
import formidable from "formidable";
import { cloudinaryConfigured, driveConfigured, env } from "../env.js";
import { getDriveToken, clearDriveToken } from "../lib/driveTokens.js";
import {
  parseDriveFolderId,
  listFolderChildren,
  getDriveItem,
  DriveApiError,
  type DriveItem,
} from "../lib/drive.js";
import {
  STORAGE_DIR,
  ensureStorageDir,
  newToken,
  isValidToken,
  zipPathForToken,
  sweepOldUploads,
} from "../lib/smartico/storage.js";
import { analyzeZip } from "../services/smartico.service.js";
import type { Job } from "bullmq";
import {
  getSmarticoQueue,
  type SmarticoQueueData,
  type SmarticoJobName,
} from "../queues/index.js";
import { TYPE_ORDER } from "../lib/smartico/detect.js";

export const smarticoRouter: Router = Router();

const MAX_ZIP_BYTES = 100 * 1024 * 1024; // 100 MB (TASK D2)

/** Strip path + .zip extension, keep a human-friendly archive name. */
function deriveZipName(originalFilename: string | null): string {
  const base = (originalFilename ?? "upload").split(/[\\/]/).pop() ?? "upload";
  return base.replace(/\.zip$/i, "").trim() || "upload";
}

smarticoRouter.post("/analyze", async (req: Request, res: Response) => {
  await ensureStorageDir();
  void sweepOldUploads(); // opportunistic cleanup of orphaned temp ZIPs

  const form = formidable({
    uploadDir: STORAGE_DIR,
    keepExtensions: false,
    maxFiles: 1,
    maxFileSize: MAX_ZIP_BYTES,
    filter: ({ originalFilename, mimetype }) =>
      Boolean(originalFilename?.toLowerCase().endsWith(".zip")) ||
      mimetype === "application/zip" ||
      mimetype === "application/x-zip-compressed",
  });

  let tempPath: string | null = null;
  try {
    const [, files] = await form.parse(req);
    const uploaded = Object.values(files).flat().find(Boolean);
    if (!uploaded) {
      res.status(400).json({ error: "no_zip_file" });
      return;
    }
    tempPath = uploaded.filepath;
    const zipName = deriveZipName(uploaded.originalFilename);

    const token = newToken();
    const finalPath = zipPathForToken(token);
    await rename(tempPath, finalPath);
    tempPath = null;

    try {
      const result = await analyzeZip(finalPath, zipName);
      if (result.brands.length === 0) {
        await rm(finalPath, { force: true });
        res.status(422).json({ error: "no_brands_detected" });
        return;
      }
      res.json({ token, ...result });
    } catch (err) {
      await rm(finalPath, { force: true });
      console.error("Smartico analyze failed:", err);
      res.status(422).json({ error: "invalid_zip" });
    }
  } catch (err: unknown) {
    if (tempPath) await rm(tempPath, { force: true }).catch(() => {});
    const code = (err as { code?: string }).code;
    if (code === "ETOOBIG" || code === "1009") {
      res.status(413).json({ error: "file_too_large", maxBytes: MAX_ZIP_BYTES });
      return;
    }
    console.error("Smartico upload failed:", err);
    res.status(400).json({ error: "upload_failed" });
  }
});

const generateSchema = z.object({
  token: z.string(),
  zipName: z.string().min(1).max(200),
  selectedTypes: z.array(z.enum(TYPE_ORDER as [string, ...string[]])).min(1),
});

smarticoRouter.post("/generate", async (req: Request, res: Response) => {
  if (!cloudinaryConfigured) {
    res.status(503).json({ error: "cloudinary_not_configured" });
    return;
  }
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { token, zipName, selectedTypes } = parsed.data;
  if (!isValidToken(token)) {
    res.status(400).json({ error: "invalid_token" });
    return;
  }
  if (!existsSync(zipPathForToken(token))) {
    res.status(410).json({ error: "upload_expired" });
    return;
  }

  // De-dupe selected types while preserving canonical order.
  const types = TYPE_ORDER.filter((t) => selectedTypes.includes(t));

  try {
    const job = await getSmarticoQueue().add("generate", { token, zipName, selectedTypes: types });
    res.status(202).json({ jobId: job.id });
  } catch (err) {
    console.error("Smartico enqueue failed:", err);
    res.status(503).json({ error: "queue_unavailable" });
  }
});

/** GET /api/smartico/jobs/:id — poll job status + result. */
smarticoRouter.get("/jobs/:id", async (req: Request, res: Response) => {
  const id = String(req.params.id ?? "");
  if (!id) {
    res.status(400).json({ error: "id_required" });
    return;
  }
  let job: Job<SmarticoQueueData, unknown, SmarticoJobName> | undefined;
  try {
    job = await getSmarticoQueue().getJob(id);
  } catch (err) {
    console.error("Smartico job lookup failed:", err);
    res.status(503).json({ error: "queue_unavailable" });
    return;
  }
  if (!job) {
    res.status(404).json({ error: "job_not_found" });
    return;
  }

  const state = await job.getState();
  const progress = typeof job.progress === "number" ? job.progress : 0;

  if (state === "completed") {
    res.json({ status: "completed", progress: 100, result: job.returnvalue });
    return;
  }
  if (state === "failed") {
    res.json({ status: "failed", progress, error: job.failedReason ?? "job_failed" });
    return;
  }
  res.json({ status: state === "active" ? "active" : "queued", progress });
});

// ============================================================================
// Google Drive navigation (Smartico × Drive)
// ----------------------------------------------------------------------------
// Interactive folder picking. All calls use the LOGGED-IN USER's own Drive token
// (kept in Redis), so a user can only ever see folders they already have access
// to — there's no privilege escalation, the access scope equals their own Drive.
// The optional SMARTICO_DRIVE_ROOT_ID locks the entry point to the shared
// "Promotional packs" folder.
// ============================================================================

/** Pull the caller's Drive token, or send a 401 telling the UI to (re)connect. */
async function requireDriveToken(req: Request, res: Response): Promise<string | null> {
  const token = await getDriveToken(req.user!.sub);
  if (!token) {
    res.status(401).json({ error: "drive_not_connected" });
    return null;
  }
  return token;
}

/** Map a Drive REST failure to an API response (and drop a dead token). */
async function handleDriveError(err: unknown, userId: string, res: Response): Promise<void> {
  if (err instanceof DriveApiError && (err.status === 401 || err.status === 403)) {
    await clearDriveToken(userId); // token expired/revoked — force a reconnect
    res.status(401).json({ error: "drive_not_connected" });
    return;
  }
  if (err instanceof DriveApiError && err.status === 404) {
    res.status(404).json({ error: "drive_folder_not_found" });
    return;
  }
  console.error("Smartico Drive error:", err);
  res.status(502).json({ error: "drive_error" });
}

const onlyFolders = (items: DriveItem[]) => items.filter((i) => i.isFolder).map((i) => ({ id: i.id, name: i.name }));

/** Is the user's Drive currently connected? (UI shows a Connect button if not.) */
smarticoRouter.get("/drive/status", async (req: Request, res: Response) => {
  if (!driveConfigured) {
    res.json({ configured: false, connected: false });
    return;
  }
  const token = await getDriveToken(req.user!.sub);
  res.json({ configured: true, connected: Boolean(token) });
});

const resolveSchema = z.object({ url: z.string().min(1).max(2000) });

/** Step 1: resolve the pasted folder URL → its top-level subfolders (branches). */
smarticoRouter.post("/drive/resolve", async (req: Request, res: Response) => {
  if (!driveConfigured) {
    res.status(503).json({ error: "drive_not_configured" });
    return;
  }
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const folderId = parseDriveFolderId(parsed.data.url);
  if (!folderId) {
    res.status(400).json({ error: "invalid_drive_url" });
    return;
  }
  // Lock to the configured root so the feature can't be pointed elsewhere.
  if (env.SMARTICO_DRIVE_ROOT_ID && folderId !== env.SMARTICO_DRIVE_ROOT_ID) {
    res.status(400).json({ error: "unexpected_root" });
    return;
  }

  const token = await requireDriveToken(req, res);
  if (!token) return;

  try {
    const meta = await getDriveItem(token, folderId);
    const children = await listFolderChildren(token, folderId);
    res.json({ rootId: folderId, rootName: meta.name, folders: onlyFolders(children) });
  } catch (err) {
    await handleDriveError(err, req.user!.sub, res);
  }
});

const childrenSchema = z.object({ folderId: z.string().min(1).max(200) });

/** Steps 2–3: list a folder's subfolders (brands, then tournaments/events). */
smarticoRouter.get("/drive/children", async (req: Request, res: Response) => {
  if (!driveConfigured) {
    res.status(503).json({ error: "drive_not_configured" });
    return;
  }
  const parsed = childrenSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }

  const token = await requireDriveToken(req, res);
  if (!token) return;

  try {
    const children = await listFolderChildren(token, parsed.data.folderId);
    res.json({ folders: onlyFolders(children) });
  } catch (err) {
    await handleDriveError(err, req.user!.sub, res);
  }
});

const driveGenerateSchema = z.object({
  branchId: z.string().min(1).max(200),
  branchName: z.string().min(1).max(200),
  eventName: z.string().min(1).max(300),
  selectedTypes: z.array(z.enum(["email", "pop-up", "push"])).min(1),
});

/** Step 4–5: enqueue the Drive generation job for the chosen event. */
smarticoRouter.post("/drive/generate", async (req: Request, res: Response) => {
  if (!cloudinaryConfigured) {
    res.status(503).json({ error: "cloudinary_not_configured" });
    return;
  }
  if (!driveConfigured) {
    res.status(503).json({ error: "drive_not_configured" });
    return;
  }
  const parsed = driveGenerateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }

  // Fail fast (before enqueue) if the user's Drive token is gone.
  const token = await getDriveToken(req.user!.sub);
  if (!token) {
    res.status(401).json({ error: "drive_not_connected" });
    return;
  }

  const { branchId, branchName, eventName, selectedTypes } = parsed.data;
  // De-dup types while preserving canonical order.
  const types = (["email", "pop-up", "push"] as const).filter((t) => selectedTypes.includes(t));
  const packName = `${branchName} — ${eventName}`;

  try {
    const job = await getSmarticoQueue().add("drive", {
      userId: req.user!.sub,
      branchId,
      branchName,
      eventName,
      packName,
      selectedTypes: types,
    });
    res.status(202).json({ jobId: job.id });
  } catch (err) {
    console.error("Smartico Drive enqueue failed:", err);
    res.status(503).json({ error: "queue_unavailable" });
  }
});
