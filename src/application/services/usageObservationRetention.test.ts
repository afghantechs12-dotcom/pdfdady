import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InMemoryUsageRepository } from "@/src/infrastructure/persistence/InMemoryUsageRepository";
import { createFileRetentionHandler } from "@/src/infrastructure/jobs/PdfToolWorkerHandler";
import type { ILogger } from "@/src/application/ports/Logger";
import { ANALYTICS_EVENTS } from "@/src/domain/metering/events";
import { MIN_OBSERVATION_DAYS } from "@/src/domain/metering/readiness";

/**
 * Whether anything in this deployment can delete the observation window out from
 * under the readiness gate.
 *
 * ── The failure this exists to prevent ──────────────────────────────────────
 *
 * The gate requires fourteen distinct days of server traffic. A retention policy
 * with a shorter horizon than that would make the requirement permanently
 * unmeetable — and unmeetable *silently*, because the symptom is a calibration
 * page that says "not enough data yet" forever while real traffic pours in. The
 * dashboard would look exactly the same on day 3 and on day 300.
 *
 * The conclusion of the audit is that nothing prunes usage data today:
 * `pruneEventsBefore`/`pruneCountersBefore` exist on the port but have no
 * production caller, the recurring `file-retention` sweep only expires stored
 * files, and `usage_events` has no relation to any row that could cascade into
 * it. So this file is the audit ASSERTED rather than a paragraph in a doc — the
 * point being that a future retention job has to make one of these tests go red
 * before it can quietly shorten the observation window.
 *
 * Note what is NOT asserted: that usage rows are kept forever. Indefinite raw-row
 * retention is not a goal, and a policy longer than the observation window is
 * perfectly fine. The requirement is only that whoever adds one is made to look
 * at `MIN_OBSERVATION_DAYS` while doing it.
 */

const ROOT = process.cwd();
const PRUNE_METHODS = ["pruneEventsBefore", "pruneCountersBefore"] as const;

/**
 * The three files allowed to name the prune methods: the port that declares them
 * and the two adapters that implement them.
 */
const DECLARING_FILES = [
  "src/application/ports/metering/UsageRepository.ts",
  "src/infrastructure/persistence/PrismaUsageRepository.ts",
  "src/infrastructure/persistence/InMemoryUsageRepository.ts",
];

/** Every non-test `.ts`/`.tsx` under `dirs`, as repo-relative paths. */
function sourceFiles(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(ROOT, rel))) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const child = `${rel}/${entry}`;
      if (statSync(join(ROOT, child)).isDirectory()) walk(child);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(child);
    }
  };
  for (const dir of dirs) walk(dir);
  return out;
}

describe("nothing in production prunes the observation window", () => {
  const files = sourceFiles(["src", "app", "lib", "components"]);

  it("finds the sources it means to audit, so the sweep cannot be vacuous", () => {
    // Without this, a broken walker would report "no callers" by finding no files.
    expect(files.length).toBeGreaterThan(200);
    for (const declaring of DECLARING_FILES) expect(files).toContain(declaring);
  });

  it("has no caller of either prune method outside the port and its adapters", () => {
    const callers: string[] = [];
    for (const file of files) {
      if (DECLARING_FILES.includes(file)) continue;
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const method of PRUNE_METHODS) {
        if (text.includes(`${method}(`)) callers.push(`${file} → ${method}`);
      }
    }
    // If this goes red, the new caller is not necessarily wrong — but it MUST keep
    // at least MIN_OBSERVATION_DAYS of usage events, and it must say so where the
    // horizon is configured.
    expect(callers, `usage pruning gained a caller; check it keeps ${MIN_OBSERVATION_DAYS} days`).toEqual([]);
  });

  it("has no other delete against the usage tables", () => {
    // A hand-written `deleteMany` would bypass the port entirely, so the check
    // above would stay green while the data went away.
    const offenders: string[] = [];
    for (const file of files) {
      if (file === "src/infrastructure/persistence/PrismaUsageRepository.ts") continue;
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const table of ["usageEvent", "usageCounter", "usageSettlement"]) {
        if (new RegExp(`${table}\\s*\\.\\s*delete`).test(text)) offenders.push(`${file} → ${table}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps usage_events free of any relation that could cascade a delete", () => {
    // No ownerId is the privacy guarantee; no relation is also what stops a user
    // deletion from taking the observation dataset with it.
    const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
    const model = schema.slice(
      schema.indexOf("model UsageEvent {"),
      schema.indexOf('@@map("usage_events")'),
    );
    expect(model.length).toBeGreaterThan(100);
    expect(model).not.toContain("@relation");
    expect(model).not.toContain("Cascade");
  });
});

describe("the recurring retention sweep leaves usage data alone", () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as ILogger;

  it("purges an expired stored file without touching the ledger or the counters", async () => {
    const usage = new InMemoryUsageRepository();
    const old = new Date(Date.now() - 400 * 86_400_000);
    await usage.recordEvent({
      eventName: ANALYTICS_EVENTS.tool_processing_completed,
      occurredAt: old,
      toolSlug: "compress-pdf",
      result: "success",
    });
    await usage.incrementCounters([
      {
        ownerType: "user",
        ownerId: "u1",
        meter: "server_operations",
        periodStart: old,
        periodEnd: new Date(old.getTime() + 86_400_000),
        delta: 1,
      },
    ]);

    const deleted: string[] = [];
    const handler = createFileRetentionHandler({
      storage: { delete: async (key: string) => void deleted.push(key) } as never,
      fileMeta: {
        listExpired: async () => [{ id: "f1", key: "jobs/abc/out.pdf" }],
        delete: async (id: string) => void deleted.push(id),
      } as never,
      scheduler: { schedule: async () => undefined } as never,
      saveIntents: { pruneBefore: async () => 0 } as never,
      logger,
    });

    const outcome = await handler({ id: "j1", type: "file-retention", payload: {} } as never, {} as never);

    // Anti-vacuity: the sweep really ran and really purged something. A handler
    // that did nothing at all would otherwise "preserve" the ledger trivially.
    expect((outcome as { result: { purged: number } }).result.purged).toBe(1);
    expect(deleted).toEqual(["jobs/abc/out.pdf", "f1"]);

    // And the four-hundred-day-old usage rows are still there.
    const window = { from: new Date(old.getTime() - 1), to: new Date() };
    expect(await usage.toolUsageSummary(window)).toHaveLength(1);
    expect(
      (
        await usage.readCounters([
          {
            ownerType: "user",
            ownerId: "u1",
            meter: "server_operations",
            periodStart: old,
            periodEnd: new Date(old.getTime() + 86_400_000),
          },
        ])
      )[0].amount,
    ).toBe(1);
  });

  it("would actually delete if pruning were ever called, so the audit above is about the caller", async () => {
    // The control for the whole file: `pruneEventsBefore` is a real delete, not a
    // stub. Without this, "no caller" and "the method does nothing" would be
    // indistinguishable, and the audit would be reassuring about nothing.
    const usage = new InMemoryUsageRepository();
    const old = new Date(Date.now() - 400 * 86_400_000);
    await usage.recordEvent({
      eventName: ANALYTICS_EVENTS.tool_processing_completed,
      occurredAt: old,
      toolSlug: "compress-pdf",
      result: "success",
    });
    expect(await usage.pruneEventsBefore(new Date())).toBe(1);
    expect(
      await usage.toolUsageSummary({ from: new Date(old.getTime() - 1), to: new Date() }),
    ).toEqual([]);
  });
});
