import "dotenv/config";
import { z } from "zod";

/**
 * Centralized, validated environment configuration.
 */
const schema = z.object({
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
  GOOGLE_DRIVE_CALLBACK_URL: z
    .string()
    .default("http://localhost:3001/auth/google/drive/callback"),
  SMARTICO_DRIVE_ROOT_ID: z.string().optional(),
  JWT_SECRET: z.string().optional(),
  BOOTSTRAP_ADMIN_EMAILS: z.string().default(""),

  // ---- Phase 4: generation providers + storage ----
  FAL_KEY: z.string().optional(),
  NANO_GPT_API_KEY: z.string().optional(),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  // ---- SMS Route Tester Module  ----
  TELQ_APP_ID: z.string().optional(),
  TELQ_APP_KEY: z.string().optional(),
  TELQ_API_URL: z.string().default("https://api.telqtele.com/v3/client"),

  MIATEL_API_URL: z.string().optional(),
  MIATEL_USERNAME: z.string().optional(),
  MIATEL_PASSWORD: z.string().optional(),

  FORTYTWO_API_URL: z.string().optional(),
  FORTYTWO_TOKEN: z.string().optional(),

  MESSAGEWHIZ_API_URL: z.string().optional(),
  MESSAGEWHIZ_API_KEY: z.string().optional(),

  DM_API_URL: z.string().optional(),
  DM_API_KEY: z.string().optional(),
  DM_TOKEN_1: z.string().optional(),
  DM_TOKEN_2: z.string().optional(),
  DM_TOKEN_3: z.string().optional(),
  DM_TOKEN_4: z.string().optional(),
  DM_TOKEN_5: z.string().optional(),
  DM_OTP_TOKEN_1: z.string().optional(),
  DM_OTP_TOKEN_2: z.string().optional(),
  DM_OTP_TOKEN_3: z.string().optional(),
  DM_OTP_TOKEN_4: z.string().optional(),

  WHITELISTED_PROXY_URL: z.string().optional(),
  REPORT_SERVER_URL: z.string().optional(),
  NGINX_AUTH: z.string().optional(),
});

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
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
);

/** Drive (Smartico) reuses the OAuth client — same readiness as login OAuth. */
export const driveConfigured = googleOAuthConfigured;

export const bootstrapAdminEmails = new Set(
  env.BOOTSTRAP_ADMIN_EMAILS.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

// ---- Phase 4 provider readiness flags ----
export const falConfigured = Boolean(env.FAL_KEY);
export const nanoGptConfigured = Boolean(env.NANO_GPT_API_KEY);
export const cloudinaryConfigured = Boolean(
  env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET
);
export const personPipelineReady = falConfigured && nanoGptConfigured && cloudinaryConfigured;
export const itemPipelineReady = nanoGptConfigured && cloudinaryConfigured;
export const editPipelineReady = falConfigured && cloudinaryConfigured;

/**
 * API-only production guard.
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