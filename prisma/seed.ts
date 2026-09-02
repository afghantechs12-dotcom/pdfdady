import { PrismaClient } from "@prisma/client";

/**
 * Database seed — idempotent defaults so `prisma db seed` can run repeatedly.
 *
 * Run with: `npm run db:seed` (configured via the `prisma.seed` package.json
 * field to use tsx). Add new seed data here as later milestones introduce
 * tables (users, orgs, flags, …).
 */
const prisma = new PrismaClient();

const DEFAULT_FLAGS: { key: string; enabled: boolean; value: string | null }[] = [
  // The new src/ architecture is live; gate NEW features behind flags as needed.
  { key: "new_architecture", enabled: true, value: null },
  { key: "ai_tools", enabled: false, value: null },
];

async function main(): Promise<void> {
  for (const f of DEFAULT_FLAGS) {
    await prisma.featureFlag.upsert({
      where: { key: f.key },
      create: f,
      update: { enabled: f.enabled },
    });
    console.log(`Seeded feature flag: ${f.key} = ${f.enabled}`);
  }
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
