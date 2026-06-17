import { Router } from "express";
import type { Request, Response } from "express";
import { rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { z } from "zod";
import formidable from "formidable";
import { cloudinaryConfigured } from "../env.js";
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
import { getSmarticoQueue, type SmarticoJobData } from "../queues/index.js";
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
  let job: Job<SmarticoJobData, unknown, "generate"> | undefined;
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
