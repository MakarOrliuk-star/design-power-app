import "dotenv/config";
import { z } from "zod";

/**
 * Centralized, validated environment configuration.
 * Generation-provider secrets (fal/nano-gpt/Cloudinary) are added in Phase 4.
 */
const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3001),

    // Postgres (Prisma). Required — the scaffold ships a local dev URL in .env.
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

    // Redis (cache + queues). Defaults to a local instance.
    REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

    // CORS origin / where to redirect the browser back to after OAuth.
    CORS_ORIGIN: z.string().min(1).default("http://localhost:3000"),
    FRONTEND_URL: z.string().min(1).default("http://localhost:3000"),

    // ---- Phase 2: Google OAuth + sessions ----
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_CALLBACK_URL: z
      .string()
      .default("http://localhost:3001/auth/google/callback"),

    // ---- Smartico × Google Drive (CRM) ----
    // Drive read access is granted by the logged-in user (incremental OAuth with
    // drive.readonly), NOT a service account — the shared "Promotional packs"
    // folder is group-restricted, so only a member's own token can read it.
    // Reuses GOOGLE_CLIENT_ID/SECRET; only the redirect URI differs.
    GOOGLE_DRIVE_CALLBACK_URL: z
      .string()
      .default("http://localhost:3001/auth/google/drive/callback"),
    // Optional: lock Drive navigation to descendants of this root folder id so
    // the listing endpoints can't be pointed at arbitrary Drive folders.
    SMARTICO_DRIVE_ROOT_ID: z.string().optional(),
    // Session JWT signing secret.
    JWT_SECRET: z.string().optional(),
    // Comma-separated emails that are auto-allowed AND promoted to ADMIN on first
    // login — bootstraps the very first admin (no admin exists to add them yet).
    BOOTSTRAP_ADMIN_EMAILS: z.string().default(""),

    // ---- Phase 4: generation providers + storage ----
    // fal.ai (Person) — synchronous fal.run (no webhook).
    FAL_KEY: z.string().optional(),

    // nano-gpt (Item images + Person prompt builder).
    NANO_GPT_API_KEY: z.string().optional(),

    // Cloudinary (result + reference storage).
    CLOUDINARY_CLOUD_NAME: z.string().optional(),
    CLOUDINARY_API_KEY: z.string().optional(),
    CLOUDINARY_API_SECRET: z.string().optional(),
  });
// NOTE: auth-only requirements (JWT_SECRET, Google creds) are NOT enforced here —
// the worker process imports this module too and must boot without them. The API
// entrypoint (index.ts) asserts those in production via assertApiProductionConfig().

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";

/** Dev-only fallback so the server boots without a configured secret. */
export const JWT_SECRET = env.JWT_SECRET ?? "dev-insecure-secret-change-me";

/** Whether Google OAuth is fully configured (routes 503 otherwise). */
export const googleOAuthConfigured = Boolean(
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET,
);

/** Drive (Smartico) reuses the OAuth client — same readiness as login OAuth. */
export const driveConfigured = googleOAuthConfigured;

export const bootstrapAdminEmails = new Set(
  env.BOOTSTRAP_ADMIN_EMAILS.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

// ---- Phase 4 provider readiness flags (generation endpoints 503 otherwise) ----
export const falConfigured = Boolean(env.FAL_KEY);
export const nanoGptConfigured = Boolean(env.NANO_GPT_API_KEY);
export const cloudinaryConfigured = Boolean(
  env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET,
);
export const personPipelineReady = falConfigured && nanoGptConfigured && cloudinaryConfigured;
export const itemPipelineReady = nanoGptConfigured && cloudinaryConfigured;
// Edit (Result page) runs fal nano-banana-2/edit on an existing image + a user
// instruction, then stores via Cloudinary — no nano-gpt prompt builder involved.
export const editPipelineReady = falConfigured && cloudinaryConfigured;

/**
 * API-only production guard. The API needs a real JWT secret + Google OAuth creds;
 * the worker does not, so this is called from index.ts (not at module load).
 */
export function assertApiProductionConfig(): void {
  if (!isProd) return;
  const missing: string[] = [];
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 16) missing.push("JWT_SECRET (>=16 chars)");
  if (!googleOAuthConfigured) missing.push("GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET");
  if (missing.length) {
    console.error("❌ Missing required production config for the API: " + missing.join(", "));
    process.exit(1);
  }
}
