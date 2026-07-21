import { createHash } from "node:crypto";
import { env } from "../env.js";

/**
 * Cloudinary signed upload — ported from the legacy GAS `uploadToCloudinary` /
 * `uploadToCloudinaryFromUrl_`. We get back `secure_url` (the value the rest of
 * the app stores). Only folder/public_id/timestamp participate in the signature.
 */

export interface CloudinaryResult {
  success: boolean;
  secure_url?: string;
  public_id?: string;
  error?: string;
  details?: string;
}

const UPLOAD_URL = () =>
  `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`;

function sign(params: Record<string, string | number>): string {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHash("sha1")
    .update(toSign + (env.CLOUDINARY_API_SECRET ?? ""))
    .digest("hex");
}

/** `file` is either a base64 data URI or a remote URL Cloudinary fetches itself. */
async function upload(
  file: string,
  fileName: string,
  folder: string,
  transformation?: string,
): Promise<CloudinaryResult> {
  try {
    const timestamp = Math.round(Date.now() / 1000);
    const publicId = fileName.replace(/\.[^/.]+$/, "");
    const signParams: Record<string, string | number> = { folder, public_id: publicId, timestamp };
    if (transformation) signParams.transformation = transformation;
    const signature = sign(signParams);

    const body = new URLSearchParams({
      file,
      api_key: env.CLOUDINARY_API_KEY ?? "",
      timestamp: String(timestamp),
      folder,
      public_id: publicId,
      signature,
      ...(transformation ? { transformation } : {}),
    });

    const res = await fetch(UPLOAD_URL(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await res.text();

    if (res.status === 200) {
      const r = JSON.parse(text) as { secure_url: string; public_id: string };
      return { success: true, secure_url: r.secure_url, public_id: r.public_id };
    }
    return { success: false, error: `Upload failed: ${res.status}`, details: text.slice(0, 300) };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export function uploadBase64(
  base64Data: string,
  fileName: string,
  folder: string,
): Promise<CloudinaryResult> {
  const clean = base64Data.includes(",") ? base64Data.split(",")[1] : base64Data;
  return upload(`data:image/png;base64,${clean}`, fileName, folder);
}

export function uploadFromUrl(
  imageUrl: string,
  fileName: string,
  folder: string,
): Promise<CloudinaryResult> {
  return upload(imageUrl, fileName, folder);
}

/**
 * Upload with a signed INCOMING transformation (applied by Cloudinary before
 * storing — the stored asset already has the target pixels). Used by the
 * bundle pipeline to cut the exact mask canvas out of a bleed-expanded image
 * (`c_crop,g_center`) or to resize a same-aspect render (`c_fill`).
 */
export function uploadFromUrlTransformed(
  imageUrl: string,
  fileName: string,
  folder: string,
  transformation: string,
): Promise<CloudinaryResult> {
  return upload(imageUrl, fileName, folder, transformation);
}

export interface ComposeLayer {
  publicId: string; // transparent cutout asset
  w: number; // fit-box width, px
  h: number; // fit-box height, px
  gravity: string; // e.g. "west", "south_east"
  x: number; // offset from the gravity corner, px
  y: number;
}

/**
 * Deterministic layer compositor (Image Bundles layered mode, D10 v2): builds
 * a Cloudinary delivery URL that places transparent cutouts (`c_fit` inside
 * their zone boxes) over a base background — the composed result is then
 * re-uploaded as the final asset. Pure URL math, zero AI calls; the zones are
 * enforced by pixels, not by the prompt.
 */
export function composeLayersUrl(basePublicId: string, layers: ComposeLayer[]): string {
  const segments = layers.map(
    (l) =>
      `l_${l.publicId.replaceAll("/", ":")},c_fit,w_${l.w},h_${l.h}/fl_layer_apply,g_${l.gravity},x_${l.x},y_${l.y}`,
  );
  const chain = segments.length ? `${segments.join("/")}/` : "";
  return `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/image/upload/${chain}${basePublicId}.png`;
}

/**
 * Upload raw image bytes via multipart/form-data (no base64 inflation — keeps
 * memory ≈ the buffer size). Used by the Smartico service, which needs a
 * deterministic public_id so a re-uploaded archive overwrites the same asset.
 * `overwrite` also invalidates the CDN cache so the new bytes are served.
 */
export async function uploadBuffer(
  buffer: Buffer,
  publicId: string,
  folder: string,
  overwrite = true,
): Promise<CloudinaryResult> {
  try {
    const timestamp = Math.round(Date.now() / 1000);
    const signParams: Record<string, string | number> = { folder, public_id: publicId, timestamp };
    if (overwrite) {
      signParams.invalidate = "true";
      signParams.overwrite = "true";
    }
    const signature = sign(signParams);

    const form = new FormData();
    // Copy into a fresh Uint8Array so the BlobPart type is satisfied (Buffer's
    // ArrayBufferLike backing isn't assignable to BlobPart under strict libs).
    form.append("file", new Blob([new Uint8Array(buffer)]), `${publicId}`);
    form.append("api_key", env.CLOUDINARY_API_KEY ?? "");
    form.append("timestamp", String(timestamp));
    form.append("folder", folder);
    form.append("public_id", publicId);
    if (overwrite) {
      form.append("invalidate", "true");
      form.append("overwrite", "true");
    }
    form.append("signature", signature);

    const res = await fetch(UPLOAD_URL(), { method: "POST", body: form });
    const text = await res.text();
    if (res.status === 200) {
      const r = JSON.parse(text) as { secure_url: string; public_id: string };
      return { success: true, secure_url: r.secure_url, public_id: r.public_id };
    }
    return { success: false, error: `Upload failed: ${res.status}`, details: text.slice(0, 300) };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

const BACKOFF_MS = [500, 1500, 3000];

/** Light retry/backoff wrapper (mirrors the legacy `*WithRetry` helpers). */
export async function withRetry(
  fn: () => Promise<CloudinaryResult>,
  label: string,
): Promise<CloudinaryResult> {
  let last: CloudinaryResult = { success: false, error: "no attempt" };
  for (let attempt = 0; attempt < 3; attempt++) {
    last = await fn();
    if (last.success) return last;
    console.warn(`⚠️ Cloudinary attempt ${attempt + 1}/3 failed for ${label}: ${last.error}`);
    if (attempt < 2) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
  }
  return last;
}
