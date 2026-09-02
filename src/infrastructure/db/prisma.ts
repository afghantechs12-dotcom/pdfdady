import { PrismaClient } from "@prisma/client";
import { getConfig } from "@/src/infrastructure/config/env";

/**
 * PrismaClient singleton (infrastructure only).
 *
 * Lazily constructed on first resolve via the DI container, so importing this
 * module never connects (and never runs at build time). The connection URL
 * comes from the validated config — swapping SQLite (dev) for PostgreSQL
 * (prod) is a `DATABASE_URL` change, with no code or schema modification.
 *
 * Business logic never imports this directly; it depends on the repository
 * interfaces, which are implemented against `PrismaClient`.
 */
let instance: PrismaClient | null = null;

export function getPrismaClient(): PrismaClient {
  if (instance) return instance;
  instance = new PrismaClient({ datasourceUrl: getConfig().databaseUrl });
  return instance;
}

/** Test-only: drop the singleton (and disconnect) so tests start clean. */
export function _resetPrismaForTests(): void {
  if (instance) {
    void instance.$disconnect();
    instance = null;
  }
}
