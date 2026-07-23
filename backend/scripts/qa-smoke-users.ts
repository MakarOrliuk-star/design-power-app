import { prisma } from "../src/lib/prisma.js";
import { signSession } from "../src/lib/jwt.js";

/**
 * Phase 7 QA helper (TASK crm-bundle): upserts two throwaway users — a
 * CRM_SUPER and a plain CRM — and prints ready-to-use session cookies for the
 * RBAC/API integration smoke against a locally running backend.
 * Run: npx tsx scripts/qa-smoke-users.ts
 */
async function main() {
  const superUser = await prisma.user.upsert({
    where: { email: "qa-crm-super@test.local" },
    create: { email: "qa-crm-super@test.local", name: "QA CRM Super", role: "CRM_SUPER" },
    update: { role: "CRM_SUPER", isActive: true },
  });
  const crmUser = await prisma.user.upsert({
    where: { email: "qa-crm@test.local" },
    create: { email: "qa-crm@test.local", name: "QA CRM", role: "CRM" },
    update: { role: "CRM", isActive: true },
  });

  console.log(
    JSON.stringify({
      superCookie: signSession({ sub: superUser.id, email: superUser.email, role: "CRM_SUPER" }),
      crmCookie: signSession({ sub: crmUser.id, email: crmUser.email, role: "CRM" }),
    }),
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
