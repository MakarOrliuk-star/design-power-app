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
  })
  .superRefine((val, ctx) => {
    if (val.NODE_ENV === "production") {
      if (!val.JWT_SECRET || val.JWT_SECRET.length < 16) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["JWT_SECRET"],
          message: "JWT_SECRET (>=16 chars) is required in production",
        });
      }
      if (!val.GOOGLE_CLIENT_ID || !val.GOOGLE_CLIENT_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["GOOGLE_CLIENT_ID"],
          message: "Google OAuth credentials are required in production",
        });
      }
    }
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
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET,
);

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
