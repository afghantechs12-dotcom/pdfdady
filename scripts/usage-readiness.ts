/**
 * USAGE READINESS — read-only report on whether enforcement may be turned on.
 *
 *   npx tsx scripts/usage-readiness.ts [--days N] [--json]
 *   npm run usage:readiness
 *
 *   --days N   window to measure over (default: the service's own calibration
 *              default). Capped at MAX_REPORT_DAYS, like every other read.
 *   --json     machine-readable output instead of the text report.
 *
 * Reads whatever `DATABASE_URL` points at — the real configured database — and
 * has no override of its own, because a readiness report about a database nobody
 * is serving from is worse than no report.
 *
 * ## Why this reuses the application services instead of querying SQL
 *
 * The thresholds and the verdict live in `src/domain/metering/readiness.ts`. A
 * script carrying its own copy of "fourteen days, five hundred operations" is a
 * second authority, and it will disagree with the first one exactly when it
 * matters: the day somebody adjusts a threshold and forgets there were two. So
 * this runs the same `UsageAnalyticsReadService.calibration()` the admin page
 * runs, against the same repository, and only formats the answer.
 *
 * ## Why it is written in TypeScript
 *
 * Reusing those modules is the whole design; a `.mjs` file could not import them.
 * `tsx` is already a devDependency and already runs the export-fidelity probe.
 *
 * ## Why it cannot write
 *
 * The repository reaches the service through a Proxy that throws on every
 * mutating method (`readOnly` below). `UsageAnalyticsReadService` has no write
 * path today, and that is exactly the point — the guard is what keeps this claim
 * true after somebody adds one. A readiness command that moved a counter would
 * corrupt the observation it exists to report on, silently, in a developer's own
 * database. The file's SHA-256 is taken before and after and compared, so the
 * guard is verified rather than merely asserted.
 *
 * ## What it prints
 *
 * Aggregates only: counts, days, tool slugs, thresholds, the verdict. No owner
 * ids, no subject hashes, no event rows, no secrets — the payload it formats is
 * the same one the admin surface renders, which is aggregate by construction.
 */
/* global process, console */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { PrismaClient } from "@prisma/client";

import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import type { IUsageRepository } from "@/src/application/ports/metering/UsageRepository";
import {
  CALIBRATION_DEFAULT_DAYS,
  MAX_REPORT_DAYS,
  UsageAnalyticsReadService,
} from "@/src/application/services/UsageAnalyticsReadService";
import { resolveLimitMode } from "@/src/application/services/UsageMeteringService";
import { PrismaUsageRepository } from "@/src/infrastructure/persistence/PrismaUsageRepository";

/** Every method on the usage port that changes data. Calling one of these throws. */
export const WRITE_METHODS: readonly string[] = [
  "incrementCounters",
  "recordEvent",
  "recordEvents",
  "claimSettlement",
  "pruneEventsBefore",
  "pruneCountersBefore",
];

export class ReadOnlyViolation extends Error {}

/** The usage repository with its writes fused. See the header note. */
export function readOnly(repo: IUsageRepository): IUsageRepository {
  const blocked = new Set(WRITE_METHODS);
  return new Proxy(repo, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && blocked.has(prop)) {
        return () => {
          throw new ReadOnlyViolation(
            `usage-readiness called ${prop}(). This command is read-only; it must never ` +
              "mutate the observation data it reports on.",
          );
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
  });
}

/**
 * The absolute file a SQLite `DATABASE_URL` names, or null for any other provider.
 *
 * The rule that matters: Prisma resolves a RELATIVE `file:` path against the
 * directory holding `schema.prisma`, not against the working directory. So this
 * repo's own `file:./prisma/dev.db` means `<root>/prisma/prisma/dev.db` — while
 * `<root>/prisma/dev.db` exists too, as a zero-byte file that has already fooled
 * one tool into reporting an empty ledger as an empty product.
 */
export function sqliteFileFor(url: string, root: string): string | null {
  if (!url.startsWith("file:")) return null;
  const raw = url.slice("file:".length);
  if (!raw || raw === ":memory:") return null;
  return isAbsolute(raw) ? raw : resolve(join(root, "prisma"), raw);
}

/**
 * `DATABASE_URL` from the environment, then `.env`, then the dev default — the
 * same three steps, in the same order, that the app itself resolves.
 *
 * A plain node process does not load `.env`; Next.js does. Skipping that step
 * would have this command read the dev fallback while the app read `.env`, and
 * report readiness for a database nobody is using.
 */
export function databaseUrl(
  root: string,
  // Read by name, so the narrowest type that admits `process.env` — the repo's
  // augmented `ProcessEnv` demands `NODE_ENV`, which this function never reads and
  // a caller testing DB resolution has no reason to supply.
  env: Record<string, string | undefined>,
): { url: string; source: string } {
  const fromEnv = env.DATABASE_URL?.trim();
  if (fromEnv) return { url: fromEnv, source: "DATABASE_URL" };
  try {
    const line = readFileSync(join(root, ".env"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /^DATABASE_URL\s*=/.test(l));
    const raw = line
      ?.slice(line.indexOf("=") + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (raw) return { url: raw, source: ".env" };
  } catch {
    // No .env is normal in production, where the variable is always set.
  }
  // Mirrors the dev fallback in src/infrastructure/config/env.ts. Unreachable in
  // production, where the startup gate requires DATABASE_URL.
  return { url: "file:./prisma/dev.db", source: "dev default" };
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Warnings and errors only: a degraded read announces itself through them, and a degraded read is the one state that must never be reported ready. */
const logger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: (message: string, fields?: LogFields) =>
    console.error(`  ! ${message}${fields ? ` ${JSON.stringify(fields)}` : ""}`),
  error: (message: string, fields?: LogFields) =>
    console.error(`  !! ${message}${fields ? ` ${JSON.stringify(fields)}` : ""}`),
  child: () => logger,
};

export async function run(argv: readonly string[], root: string): Promise<number> {
  const { url, source } = databaseUrl(root, process.env);
  const file = sqliteFileFor(url, root);
  const json = argv.includes("--json");
  const daysArg = Number(argv[argv.indexOf("--days") + 1]);
  const days =
    argv.includes("--days") && Number.isFinite(daysArg) && daysArg > 0
      ? Math.min(Math.trunc(daysArg), MAX_REPORT_DAYS)
      : CALIBRATION_DEFAULT_DAYS;

  let before: string | null = null;
  if (file) {
    try {
      before = sha256(file);
    } catch {
      console.error(
        `Database file not found: ${file}\n` +
          "Prisma resolves a relative file: URL against the prisma/ directory, so " +
          "file:./prisma/dev.db means prisma/prisma/dev.db.",
      );
      return 2;
    }
  }

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const service = new UsageAnalyticsReadService({
    usage: readOnly(new PrismaUsageRepository(prisma)),
    logger,
    limitMode: resolveLimitMode(process.env.USAGE_LIMIT_MODE),
  });

  const now = Date.now();
  let report: Awaited<ReturnType<UsageAnalyticsReadService["calibration"]>>;
  try {
    report = await service.calibration({
      from: new Date(now - days * 86_400_000).toISOString(),
      to: new Date(now).toISOString(),
    });
  } finally {
    await prisma.$disconnect();
  }

  // The Proxy asserts read-only; this verifies it. A guard nobody checks is a comment.
  if (file && before !== null && sha256(file) !== before) {
    console.error(`READ-ONLY VIOLATION: ${file} changed while reporting.`);
    return 3;
  }

  const { observation, readiness, window } = report;
  const { observed, thresholds } = readiness;

  if (json) {
    console.log(
      JSON.stringify(
        {
          database: { source, provider: file ? "sqlite" : "other", file, sha256: before },
          limitMode: observation.limitMode,
          window,
          readiness,
          limitEvents: observation.limitEvents,
          degraded: observation.degraded,
          serverTools: observation.tools
            .filter((t) => t.executionMode === "remote_job")
            .map((t) => ({ toolSlug: t.toolSlug, operations: t.operations })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const met = (have: number, need: number) => `${have} / ${need}${have >= need ? " ✓" : ""}`;
  const out: string[] = [
    "PDFDadi — usage limit readiness",
    `  database          ${file ?? url} (from ${source})`,
    ...(before ? [`  db sha256         ${before}`] : []),
    `  USAGE_LIMIT_MODE  ${observation.limitMode}`,
    `  window            ${window.from.slice(0, 10)} → ${window.to.slice(0, 10)} (${window.days} day span${window.clamped ? ", clamped" : ""})`,
    "",
    `  ready_for_enforcement  ${readiness.ready_for_enforcement}`,
    `  reason                 ${readiness.reason}`,
    "",
    `  days with traffic      ${met(observed.days, thresholds.minObservationDays)}`,
    `  server operations      ${met(observed.operations, thresholds.minOperations)}`,
    `  server tools used      ${met(observed.toolsObserved, thresholds.minTools)}`,
    `  operations per day     ${observed.operationsPerDay.toFixed(1)} (mean)`,
    `  guest share            ${observed.guestShare === null ? "—" : `${Math.round(observed.guestShare * 100)}%`}`,
    `  would have blocked     ${observed.wouldHaveBlocked === null ? "n/a (not observing)" : observed.wouldHaveBlocked}`,
    `  limit events recorded  ${observation.limitEvents}`,
  ];
  if (observed.excludedOperations > 0) {
    out.push(
      `  excluded               ${observed.excludedOperations} attempt(s) on local tools or ` +
        "unregistered slugs, which consume no server capacity",
    );
  }
  if (observation.degraded) {
    out.push(
      "",
      "  DEGRADED: at least one usage query failed, so every figure above is a",
      "  minimum rather than a total and enforcement stays refused.",
    );
  }
  if (readiness.gaps.length > 0) {
    out.push("", "  gaps:", ...readiness.gaps.map((gap) => `    · ${gap}`));
  }
  const serverTools = observation.tools
    .filter((t) => t.executionMode === "remote_job")
    .sort((a, b) => b.operations - a.operations);
  out.push("");
  out.push(
    ...(serverTools.length === 0
      ? ["  No server-tool activity in this window."]
      : [
          "  server tools with traffic:",
          ...serverTools.map((t) => `    ${t.toolSlug.padEnd(24)} ${t.operations}`),
        ]),
  );
  console.log(out.join("\n"));
  return 0;
}

// Run only when invoked as a command. Tests import the guards above, and a module
// that connected to a database on import would make them impossible to unit-test.
if (/usage-readiness/.test(process.argv[1] ?? "")) {
  run(process.argv.slice(2), process.cwd())
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
