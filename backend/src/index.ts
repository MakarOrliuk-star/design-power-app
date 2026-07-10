import express from "express";
import { initCronJobs } from "./services/cron.js"
import cors from "cors";
import cookieParser from "cookie-parser";
import { env, assertApiProductionConfig } from "./env.js";
import { healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { adminRouter } from "./routes/admin.js";
import { catalogRouter } from "./routes/catalog.js";
import { generateRouter } from "./routes/generate.js";
import { tournamentRouter } from "./routes/tournament.js";
import { tournamentAdminRouter } from "./routes/tournamentAdmin.js";
import {
  loadUser,
  requireAdmin,
  requireAdminOrManager,
  requireAuth,
  requireZone,
} from "./middleware/auth.js";
import { calculatorRouter } from "./routes/calculator.js";
import { auditorRouter } from "./routes/auditor.js";
import { crmRouter } from "./routes/crm.js";
import { smarticoRouter } from "./routes/smartico.js";
import { startSmarticoWorker, stopSmarticoWorker } from "./queues/smartico.worker.js";

import { calculatorService } from "./services/calculator.service.js";
import { CRYPTO_CODES } from "./config/calculator.config.js";

assertApiProductionConfig();

const app = express();

app.use(
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true,
  }),
);
app.use(express.json({ limit: "25mb" })); // base64 image uploads land in later phases
app.use(cookieParser());

app.get("/", (_req, res) => {
  res.json({ name: "design-power-backend", status: "running" });
});

app.use("/health", healthRouter);
app.use("/auth", authRouter);
app.use("/api/admin", loadUser, requireAdmin, adminRouter);
// Zone guards: Design (DESIGNER) vs CRM (CRM); ADMIN passes both (see requireZone).
app.use("/api/catalog", loadUser, requireAuth, requireZone("DESIGNER"), catalogRouter);
app.use("/api/calculator", loadUser, requireAuth, requireZone("CRM"), calculatorRouter);
app.use("/api/auditor", loadUser, requireAuth, requireZone("CRM"), auditorRouter);
app.use("/api/smartico", loadUser, requireAuth, requireZone("CRM"), smarticoRouter);
app.use("/api/crm", loadUser, requireAuth, requireZone("CRM"), crmRouter);
app.use("/api/tournament-admin", loadUser, requireAuth, requireAdminOrManager, tournamentAdminRouter);
app.use("/api/tournament", loadUser, requireAuth, requireZone("DESIGNER"), tournamentRouter);
// Generic /api (generate) is a Design-zone route — keep it last so the more
// specific prefixes above match first.
app.use("/api", loadUser, requireAuth, requireZone("DESIGNER"), generateRouter);

const server = app.listen(env.PORT, "0.0.0.0", () => {
  console.log(`Backend listening on http://0.0.0.0:${env.PORT} (${env.NODE_ENV})`);
  initCronJobs();

  
  calculatorService.fetchFiatRates();
  calculatorService.fetchCryptoRates(CRYPTO_CODES);

  setInterval(() => {

    calculatorService.fetchFiatRates();
    calculatorService.fetchCryptoRates(CRYPTO_CODES);
  }, 24 * 60 * 60 * 1000);
  
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
