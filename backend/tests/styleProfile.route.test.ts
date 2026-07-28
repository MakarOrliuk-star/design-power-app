import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// Ручной override style-profile (DV-E1, ограничение 4). prisma и Cloudinary
// замоканы; кламп работает по-настоящему — он и есть предмет проверки:
// координаты и мусор не должны доезжать до БД даже руками админа.
const db = vi.hoisted(() => ({
  bundleBrandVariant: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
}));
const cloud = vi.hoisted(() => ({
  uploadBase64: vi.fn(),
  withRetry: vi.fn(),
}));
vi.mock("../src/env.js", () => ({
  env: {},
  JWT_SECRET: "test-secret-key",
  cloudinaryConfigured: true,
  personPipelineReady: true,
}));
vi.mock("../src/lib/prisma.js", () => ({ prisma: db }));
vi.mock("../src/lib/cloudinary.js", () => cloud);

import { adminRouter } from "../src/routes/admin.js";
import { Prisma } from "../generated/prisma/client.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  // Тест — про сам роут; loadUser/requireAdmin проверяются своим слоем.
  app.use("/api/admin", adminRouter);
  return app;
}

const LIB = ["https://cdn/decor/coin.png", "https://cdn/decor/bill.png"];

const variantRow = () => ({
  id: "v1",
  brandName: "Betnella(Men)",
  bundle: {
    bundleType: {
      assets: [
        { key: "email", composeMode: "layered", decorUrls: LIB },
        { key: "push", composeMode: "layered" },
        { key: "banner", composeMode: "ai", decorUrls: ["https://cdn/ai-only.png"] },
      ],
    },
  },
});

beforeEach(() => {
  db.bundleBrandVariant.findUnique.mockReset();
  db.bundleBrandVariant.update.mockReset();
  db.bundleBrandVariant.findUnique.mockResolvedValue(variantRow());
  db.bundleBrandVariant.update.mockImplementation(
    async (args: { data: { styleProfile: unknown } }) => ({
      id: "v1",
      brandName: "Betnella(Men)",
      styleProfile: args.data.styleProfile === Prisma.DbNull ? null : args.data.styleProfile,
    }),
  );
});

describe("PATCH /api/admin/bundle-variants/:id/style-profile", () => {
  it("сохраняет клампованный профиль с source=manual", async () => {
    const res = await request(makeApp())
      .patch("/api/admin/bundle-variants/v1/style-profile")
      .send({
        profile: {
          glowHex: "#ab12cd",
          typoMaterial: "silver",
          tokens: ["free spins"],
          density: 2, // выше коридора — обязан прижаться к 1
          decorUrls: [LIB[1], "https://evil/x.png"],
        },
      });
    expect(res.status).toBe(200);
    const saved = db.bundleBrandVariant.update.mock.calls[0]![0].data.styleProfile;
    expect(saved).toEqual({
      glowHex: "#AB12CD",
      typoMaterial: "silver",
      tokens: ["FREE SPINS"],
      density: 1,
      decorUrls: [LIB[1]],
      source: "manual",
    });
  });

  it("профиль из одного мусора → 400 с внятной причиной, БД не трогается", async () => {
    const res = await request(makeApp())
      .patch("/api/admin/bundle-variants/v1/style-profile")
      .send({ profile: { typoMaterial: "vantablack", decorUrls: ["https://evil/x.png"] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_profile");
    expect(db.bundleBrandVariant.update).not.toHaveBeenCalled();
  });

  it("profile: null снимает override (DbNull) — следующий prepare спросит модель", async () => {
    const res = await request(makeApp())
      .patch("/api/admin/bundle-variants/v1/style-profile")
      .send({ profile: null });
    expect(res.status).toBe(200);
    expect(db.bundleBrandVariant.update.mock.calls[0]![0].data.styleProfile).toBe(Prisma.DbNull);
  });

  it("неизвестный вариант → 404", async () => {
    db.bundleBrandVariant.findUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .patch("/api/admin/bundle-variants/nope/style-profile")
      .send({ profile: null });
    expect(res.status).toBe(404);
  });
});
