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
import { loadUser, requireAdmin, requireAuth } from "./middleware/auth.js";
import { calculatorRouter } from "./routes/calculator.js";
import { auditorRouter } from "./routes/auditor.js";

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
app.use("/api/catalog", loadUser, requireAuth, catalogRouter);
app.use("/api", loadUser, requireAuth, generateRouter);
app.use("/api/calculator", loadUser, requireAuth, calculatorRouter);
app.use("/api/auditor", loadUser, requireAuth, auditorRouter); 

const server = app.listen(env.PORT, "0.0.0.0", () => {
  console.log(`Backend listening on http://0.0.0.0:${env.PORT} (${env.NODE_ENV})`);
  initCronJobs();
});

// Graceful shutdown so `tsx watch` restarts don't leak the port.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} received — shutting down`);
    server.close(() => process.exit(0));
  });
}
