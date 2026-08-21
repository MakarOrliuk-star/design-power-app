import express from "express";
import { initCronJobs } from "./services/cron.js"
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import { env, assertApiProductionConfig } from "./env.js";
import { healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { adminRouter } from "./routes/admin.js";
import { decorRouter } from "./routes/decor.js";
import { patternSpecAdminRouter } from "./routes/patternSpecAdmin.js";
import { catalogRouter } from "./routes/catalog.js";
import { generateRouter } from "./routes/generate.js";
import { tournamentRouter } from "./routes/tournament.js";
import { tournamentAdminRouter } from "./routes/tournamentAdmin.js";
import { tournamentPackRouter } from "./routes/tournamentPack.js";
import { welcomeRouter } from "./routes/welcome.js";
import { welcomeAdminRouter } from "./routes/welcomeAdmin.js";
import { welcomePackRouter } from "./routes/welcomePack.js";
import { myBrandsRouter } from "./routes/myBrands.js";
import { gameRouter } from "./routes/game.js";
import {
  loadUser,
  requireAdmin,
  requireAdminOrManager,
  requireAuth,
  requireCrmSuper,
  requireGameZone,
  requireSuperDesigner,
  requireZone,
} from "./middleware/auth.js";
import { bundlesRouter } from "./routes/bundles.js";
import { crmAdminRouter } from "./routes/crmAdmin.js";
import { calculatorRouter } from "./routes/calculator.js";
import { crmRouter } from "./routes/crm.js";
import { smarticoRouter } from "./routes/smartico.js";
import { startSmarticoWorker, stopSmarticoWorker } from "./queues/smartico.worker.js";
import { qatoolsRouter } from "./routes/qatools.js";

import { calculatorService } from "./services/calculator.service.js";

import { smsRouter } from "./routes/sms.js";
import { exportSmsRouter } from "./routes/export.sms.js";

assertApiProductionConfig();

const app = express();

// Railway terminates TLS one hop in front of us, and the frontend's Nitro proxy
// is another. Without this, req.ip is the proxy's address — which would make
// every rate limiter below bucket the entire internet into a single counter.
app.set("trust proxy", 1);

/**
 * Security headers. This is a JSON API — it serves no HTML and loads no
 * subresources — so the browser-facing policies (CSP, HSTS, framing) are the
 * frontend's job and are set in the Nitro layer. What matters here:
 *  - contentSecurityPolicy: off. A CSP on API responses protects nothing and
 *    would only risk breaking an error page.
 *  - crossOriginResourcePolicy: off. The frontend proxy is a different origin
 *    to this process, and "same-origin" (helmet's default) would block it.
 */
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true,
  }),
);
app.use(express.json({ limit: "25mb" })); // base64 image uploads land in later phases
app.use(cookieParser());

/**
 * Rate limits. Deliberately only on the two surfaces where an unauthenticated
 * or cheap-to-repeat request costs us something real — the OAuth entry point
 * and the generation/upload endpoints, which spend provider credits and CPU.
 * The rest of the API sits behind a session cookie and an allowlist-gated
 * login, so a blanket limiter would add false positives without adding safety.
 *
 * Both are IP-based and skip nothing: a shared office IP hitting the login
 * ceiling is the intended behaviour, the window is short enough to self-heal.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30, // OAuth round-trips per IP per 15 min — a human needs 1-2
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "too_many_requests" },
});

const expensiveLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60, // generation + upload calls per IP per minute
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "too_many_requests" },
});

app.get("/", (_req, res) => {
  res.json({ name: "design-power-backend", status: "running" });
});

app.use("/health", healthRouter);
app.use("/auth", authLimiter, authRouter);
// Библиотека декора (Задание 2, Фаза 2). Монтируется ДО `/api/admin`: префикс
// у adminRouter более общий, и он перехватил бы запрос первым.
app.use("/api/admin/decor", loadUser, requireAdmin, decorRouter);
// Pattern-спеки (Задание 3): майнер по корпусу эталонов из админки. Тоже до
// общего /api/admin — иначе его перехватит adminRouter.
app.use("/api/admin/pattern-specs", loadUser, requireAdmin, patternSpecAdminRouter);
app.use("/api/admin", loadUser, requireAdmin, adminRouter);
// Zone guards: Design (DESIGNER) vs CRM (CRM); ADMIN passes both (see requireZone).
app.use("/api/catalog", loadUser, requireAuth, requireZone("DESIGNER"), catalogRouter);
app.use("/api/calculator", loadUser, requireAuth, requireZone("CRM"), calculatorRouter);
app.use("/api/smartico", loadUser, requireAuth, requireZone("CRM"), smarticoRouter);
app.use("/api/qa-tools", loadUser, requireAuth, requireZone("CRM"), qatoolsRouter);
app.use("/api/crm", loadUser, requireAuth, requireZone("CRM"), crmRouter);
app.use("/api/sms", loadUser, requireAuth, requireZone("CRM"), smsRouter);
app.use("/api/sms/export", loadUser, requireAuth, requireZone("CRM"), exportSmsRouter);
// Image Bundles (TASK crm-bundle): CRM_SUPER / ADMIN / MANAGER only (D4).
app.use("/api/bundles", loadUser, requireAuth, requireCrmSuper, bundlesRouter);
// CRM-админка (TASK ai-reference, DI-R12): вариации + референсы для CRM_SUPER.
app.use("/api/crm-admin", loadUser, requireAuth, requireCrmSuper, crmAdminRouter);
app.use("/api/tournament-admin", loadUser, requireAuth, requireAdminOrManager, tournamentAdminRouter);
// «Edit Tournament pack» (TASK tournament-pack): the same tournament data as the
// admin panel, but audited + rollback-able, for SUPER_DESIGNER / ADMIN / MANAGER.
app.use("/api/tournament-pack", loadUser, requireAuth, requireSuperDesigner, tournamentPackRouter);
app.use("/api/tournament", loadUser, requireAuth, requireZone("DESIGNER"), tournamentRouter);
// Welcome packs (TASK welcome-packs): the same three-surface split as the
// tournaments — admin panel, the audited super-designer window, and the
// designers' page itself. Order matters: the more specific prefixes first.
app.use("/api/welcome-admin", loadUser, requireAuth, requireAdminOrManager, welcomeAdminRouter);
app.use("/api/welcome-pack", loadUser, requireAuth, requireSuperDesigner, welcomePackRouter);
app.use("/api/welcome", loadUser, requireAuth, requireZone("DESIGNER"), welcomeRouter);
// Super-designer surface (own-brand CRUD + brand test runs).
app.use("/api/my-brands", loadUser, requireAuth, requireSuperDesigner, myBrandsRouter);
// Game module (TASK game-manager): its own zone guard, not requireZone —
// GAME_MANAGER belongs to no other zone and MANAGER must not slip in through
// requireZone's blanket pass. Above the catch-all /api for the usual reason.
app.use("/api/game", expensiveLimiter, loadUser, requireAuth, requireGameZone, gameRouter);
// Generic /api (generate) is a Design-zone route — keep it last so the more
// specific prefixes above match first.
app.use("/api", expensiveLimiter, loadUser, requireAuth, requireZone("DESIGNER"), generateRouter);

const server = app.listen(env.PORT, "0.0.0.0", () => {
  console.log(`Backend listening on http://0.0.0.0:${env.PORT} (${env.NODE_ENV})`);
  initCronJobs();

  calculatorService.checkAndRefreshRates();

  setInterval(() => {
    calculatorService.checkAndRefreshRates();
  }, 60 * 60 * 1000);
  
  // Smartico jobs read the uploaded ZIP from this container's local temp dir, so
  // they must be processed here (not on the separate worker container).
  startSmarticoWorker();
});

// Graceful shutdown so `tsx watch` restarts don't leak the port.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} received — shutting down`);
    void stopSmarticoWorker().finally(() => server.close(() => process.exit(0)));
  });
}