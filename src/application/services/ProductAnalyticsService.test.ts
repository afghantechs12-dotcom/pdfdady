import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryUsageRepository } from "@/src/infrastructure/persistence/InMemoryUsageRepository";
import {
  MAX_EVENTS_PER_BATCH,
  ProductAnalyticsService,
  occurredAtFor,
  type AnalyticsActor,
} from "./ProductAnalyticsService";
import type { IEntitlementProvider } from "@/src/application/ports/metering/EntitlementProvider";
import type { PlanId } from "@/src/domain/metering/plans";

/**
 * The ingest path is the only place a browser can write to the analytics ledger,
 * so these tests attack it the way an attacker or a careless client would: by
 * sending identity, sending server-authoritative events, sending PII in declared
 * and undeclared properties, and sending enough of it to matter.
 *
 * Run against the REAL in-memory repository rather than a mock, so an assertion
 * about what was stored is an assertion about a row and not about a call.
 */

const NOW = new Date("2026-08-24T12:00:00.000Z");

function entitlements(plan: PlanId = "free"): IEntitlementProvider {
  return { planFor: async () => plan };
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

const USER: AnalyticsActor = { ownerType: "user", ownerId: "user-1" };
const GUEST: AnalyticsActor = { ownerType: "anon", ownerId: "anon-cookie-1" };

let usage: InMemoryUsageRepository;

function service(overrides: Partial<{ plan: PlanId; secret: string | null }> = {}) {
  return new ProductAnalyticsService({
    usage,
    entitlements: entitlements(overrides.plan ?? "free"),
    logger,
    subjectSecret: overrides.secret === undefined ? "test-secret" : overrides.secret,
    now: () => NOW,
  });
}

beforeEach(() => {
  usage = new InMemoryUsageRepository();
  logger.warn.mockClear();
});

describe("what a client may send", () => {
  it("records an allowlisted funnel event", async () => {
    const result = await service().ingest({
      actor: GUEST,
      events: [{ name: "tool_view", properties: { toolSlug: "merge-pdf" } }],
    });
    expect(result.accepted).toBe(1);
    expect(result.dropped).toBe(0);
    const [row] = usage.recordedEvents();
    expect(row.eventName).toBe("tool_view");
    expect(row.toolSlug).toBe("merge-pdf");
  });

  /**
   * The core trust boundary. `tool_processing_completed` is what the WORKER
   * observed; if a browser could post it, anyone could write "this tool failed
   * 40,000 times" into the dataset the dashboards read, with no way afterwards to
   * tell injected rows from measured ones.
   */
  it("drops server-authoritative events even though the taxonomy knows them", async () => {
    const result = await service().ingest({
      actor: USER,
      events: [
        { name: "tool_processing_completed", properties: { result: "success" } },
        { name: "limit_reached", properties: { meter: "server_operations" } },
        { name: "signup", properties: { method: "password" } },
        { name: "login", properties: { method: "password" } },
      ],
    });
    expect(result.accepted).toBe(0);
    expect(result.dropped).toBe(4);
    expect(usage.recordedEvents()).toEqual([]);
  });

  it("drops an unknown event name without failing the batch around it", async () => {
    const result = await service().ingest({
      actor: GUEST,
      events: [
        { name: "tool_view" },
        { name: "definitely_not_an_event" },
        { name: "download", properties: { format: "pdf" } },
      ],
    });
    expect(result.accepted).toBe(2);
    expect(result.dropped).toBe(1);
    expect(usage.recordedEvents().map((e) => e.eventName)).toEqual(["tool_view", "download"]);
  });

  it("caps a batch and drops the excess rather than writing it", async () => {
    const events = Array.from({ length: MAX_EVENTS_PER_BATCH + 7 }, () => ({
      name: "tool_view" as const,
    }));
    const result = await service().ingest({ actor: GUEST, events });
    expect(result.accepted).toBe(MAX_EVENTS_PER_BATCH);
    expect(result.dropped).toBe(7);
    expect(usage.recordedEvents()).toHaveLength(MAX_EVENTS_PER_BATCH);
  });
});

describe("what a client may never store", () => {
  /** The privacy promise, attacked with exactly the fields the brief forbids. */
  it("stores no filename, document text, url, token or cookie", async () => {
    await service().ingest({
      actor: USER,
      events: [
        {
          name: "download",
          properties: {
            format: "pdf",
            filename: "Q3-layoffs.pdf",
            text: "CONFIDENTIAL board minutes",
            content: "%PDF-1.7",
            url: "https://r2.example.com/signed?sig=abc",
            token: "session-token",
            cookie: "pdfdadi_jid=abc",
            email: "someone@example.com",
            path: "/tmp/upload/x.pdf",
          },
        },
      ],
    });
    const [row] = usage.recordedEvents();
    const serialized = JSON.stringify(row);
    for (const leak of [
      "Q3-layoffs",
      "CONFIDENTIAL",
      "%PDF",
      "r2.example.com",
      "session-token",
      "someone@example.com",
      "/tmp/upload",
    ]) {
      expect(serialized).not.toContain(leak);
    }
    expect(row.properties).toMatchObject({ format: "pdf" });
  });

  /**
   * `ownerId` has no field on `UsageEventRecord` at all, so this asserts the
   * consequence: whatever the client calls it, no row carries the actor's id.
   */
  it("never writes an owner id, however the client spells it", async () => {
    await service().ingest({
      actor: { ownerType: "user", ownerId: "secret-user-id" },
      events: [
        {
          name: "tool_start",
          properties: { ownerId: "secret-user-id", userId: "secret-user-id" },
        },
      ],
    });
    const [row] = usage.recordedEvents();
    expect(JSON.stringify(row)).not.toContain("secret-user-id");
    expect("ownerId" in row).toBe(false);
  });

  /**
   * The claim-overwrite attack the allowlist alone does NOT stop: `plan` and
   * `ownerType` are declared common properties, because the SERVER sets them. A
   * client sending them must not win.
   */
  it("overwrites a client-claimed plan and actor class with the resolved ones", async () => {
    await service({ plan: "free" }).ingest({
      actor: GUEST,
      events: [
        { name: "tool_view", properties: { plan: "business", ownerType: "system" } },
      ],
    });
    const [row] = usage.recordedEvents();
    expect(row.planId).toBe("free");
    expect(row.ownerType).toBe("anon");
    expect(row.properties?.plan).toBe("free");
    expect(row.properties?.ownerType).toBe("anon");
  });
});

describe("pseudonymous funnel identity", () => {
  it("is stable within a day for one actor and different between actors", async () => {
    const svc = service();
    await svc.ingest({ actor: USER, events: [{ name: "tool_view" }, { name: "download" }] });
    await svc.ingest({ actor: GUEST, events: [{ name: "tool_view" }] });
    const rows = usage.recordedEvents();
    expect(rows[0].subjectHash).toBe(rows[1].subjectHash);
    expect(rows[2].subjectHash).not.toBe(rows[0].subjectHash);
  });

  /** Rotation is what bounds stitching to a day instead of building a history. */
  it("rotates daily, so yesterday's rows cannot be relinked to today's", async () => {
    const day1 = new Date("2026-08-24T23:59:00.000Z");
    const day2 = new Date("2026-08-25T00:01:00.000Z");
    const svc = service();
    await svc.ingest({ actor: USER, events: [{ name: "tool_view" }], at: day1 });
    await svc.ingest({ actor: USER, events: [{ name: "tool_view" }], at: day2 });
    const [a, b] = usage.recordedEvents();
    expect(a.subjectHash).not.toBe(b.subjectHash);
  });

  it("is not the raw id, nor a bare digest of it", async () => {
    const { createHash } = await import("node:crypto");
    await service().ingest({ actor: USER, events: [{ name: "tool_view" }] });
    const [row] = usage.recordedEvents();
    expect(row.subjectHash).not.toContain("user-1");
    // A plain sha256 would be reversible for an enumerable id space, and both of
    // ours are enumerable.
    expect(row.subjectHash).not.toBe(
      createHash("sha256").update("user:user-1").digest("hex").slice(0, 32),
    );
  });

  /**
   * The salt must be KEYED, not merely derived. A day key is public — anyone
   * knows today's date — so an unkeyed salt is one an attacker can recompute,
   * and the hash of an enumerable id space is then reversible by brute force.
   * Only the secret makes it a pseudonym rather than an encoding.
   */
  it("depends on the configured secret, so the salt cannot be recomputed", async () => {
    const at = new Date("2026-08-24T12:00:00.000Z");
    await service({ secret: "secret-a" }).ingest({
      actor: USER,
      events: [{ name: "tool_view" }],
      at,
    });
    await service({ secret: "secret-b" }).ingest({
      actor: USER,
      events: [{ name: "tool_view" }],
      at,
    });
    const [a, b] = usage.recordedEvents();
    expect(a.subjectHash).not.toBe(b.subjectHash);
  });

  /** No secret configured must degrade to "no stitching", never to a constant salt. */
  it("records without a subject hash when no secret is configured", async () => {
    await service({ secret: null }).ingest({ actor: USER, events: [{ name: "tool_view" }] });
    const [row] = usage.recordedEvents();
    expect(row.subjectHash).toBeNull();
    expect(row.eventName).toBe("tool_view");
  });
});

describe("it cannot break a tool, and cannot move a quota", () => {
  /**
   * The requirement stated as an assertion on the substrate: no counter row
   * exists after any amount of client traffic. A beacon anyone can POST must not
   * be able to consume the allowance that refuses someone's work.
   */
  it("writes no counter row, for any event or volume", async () => {
    const svc = service();
    for (const name of ["tool_view", "file_selected", "tool_start", "job_succeeded", "download"]) {
      await svc.ingest({ actor: USER, events: [{ name, properties: { fileCount: 3 } }] });
    }
    for (const meter of ["server_operations", "server_input_bytes", "compute_units"]) {
      expect(
        usage.counterAmount({
          ownerType: "user",
          ownerId: "user-1",
          meter,
          periodStart: new Date("2026-08-24T00:00:00.000Z"),
        }),
      ).toBe(0);
      expect(
        usage.counterAmount({
          ownerType: "user",
          ownerId: "user-1",
          meter,
          periodStart: new Date("2026-08-01T00:00:00.000Z"),
        }),
      ).toBe(0);
    }
  });

  it("resolves and reports degraded when the ledger write fails, instead of throwing", async () => {
    vi.spyOn(usage, "recordEvents").mockRejectedValueOnce(new Error("db down"));
    const result = await service().ingest({ actor: USER, events: [{ name: "tool_view" }] });
    expect(result.degraded).toBe(true);
    expect(result.accepted).toBe(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("still records events when the plan lookup throws", async () => {
    const svc = new ProductAnalyticsService({
      usage,
      entitlements: {
        planFor: async () => {
          throw new Error("org lookup down");
        },
      },
      logger,
      subjectSecret: "test-secret",
      now: () => NOW,
    });
    const result = await svc.ingest({ actor: GUEST, events: [{ name: "tool_view" }] });
    expect(result.accepted).toBe(1);
    // Least generous applicable plan for an anonymous visitor, never the best.
    expect(usage.recordedEvents()[0].planId).toBe("guest");
  });

  it("does not consult the plan at all for a batch with nothing acceptable in it", async () => {
    const planFor = vi.fn(async () => "free" as PlanId);
    const svc = new ProductAnalyticsService({
      usage,
      entitlements: { planFor },
      logger,
      now: () => NOW,
    });
    const result = await svc.ingest({ actor: USER, events: [{ name: "nope" }] });
    expect(result.accepted).toBe(0);
    expect(planFor).not.toHaveBeenCalled();
  });

  /** One lookup per batch, not per event: a six-event funnel is one read. */
  it("resolves the plan once for a whole batch", async () => {
    const planFor = vi.fn(async () => "pro" as PlanId);
    const svc = new ProductAnalyticsService({
      usage,
      entitlements: { planFor },
      logger,
      now: () => NOW,
    });
    await svc.ingest({
      actor: USER,
      events: [{ name: "tool_view" }, { name: "tool_start" }, { name: "download" }],
    });
    expect(planFor).toHaveBeenCalledTimes(1);
  });
});

describe("client clocks", () => {
  it("keeps a plausible client timestamp, so batched order survives", () => {
    const client = NOW.getTime() - 30_000;
    expect(occurredAtFor(client, NOW).getTime()).toBe(client);
  });

  /**
   * A future timestamp is the damaging direction: it stays inside every
   * "up to now" window forever and inflates the current day.
   */
  it("replaces a future timestamp with the server's now", () => {
    expect(occurredAtFor(NOW.getTime() + 60_000, NOW).getTime()).toBe(NOW.getTime());
  });

  it("replaces a wildly skewed or unusable timestamp with the server's now", () => {
    for (const bad of [0, Number.NaN, Number.POSITIVE_INFINITY, undefined, NOW.getTime() - 864e5]) {
      expect(occurredAtFor(bad as number | undefined, NOW).getTime()).toBe(NOW.getTime());
    }
  });

  it("files a stored event under the clamped instant", async () => {
    await service().ingest({
      actor: USER,
      events: [{ name: "tool_view", at: NOW.getTime() + 999_999 }],
    });
    expect(usage.recordedEvents()[0].occurredAt.getTime()).toBe(NOW.getTime());
  });
});

/**
 * The failure category has to be readable on the dimension the dashboard groups
 * by, which is the COLUMN — not the `properties` blob it also lands in.
 *
 * This is the gap these tests exist for now. Every layer was already correct in
 * isolation: the taxonomy is closed, the provider sends the category, ingest
 * declares and sanitizes it, and the read service groups `job_failed` rows by
 * `errorCategory`. It still produced an empty category list on a live dashboard
 * beside a non-zero "unclassified" count, because the one thing nothing asserted
 * was that ingest FILLS the dimension the reader reads. A property-level
 * assertion passes either way, so it has to be the column.
 */
describe("a local failure's category reaches the dimension the dashboard groups by", () => {
  it("writes the category to the column, not only into properties", async () => {
    await service().ingest({
      actor: GUEST,
      events: [
        {
          name: "job_failed",
          properties: {
            toolSlug: "remove-pdf-metadata",
            executionMode: "local",
            errorCategory: "corrupt_document",
          },
        },
      ],
    });
    const [row] = usage.recordedEvents();
    expect(row.errorCategory).toBe("corrupt_document");
    expect(row.properties?.errorCategory).toBe("corrupt_document");
  });

  it("is counted as a category by the same query the dashboard runs", async () => {
    // The end-to-end shape of the bug: one grouped read over the stored row. A
    // row whose category lives only in JSON returns the null bucket here.
    await service().ingest({
      actor: GUEST,
      events: [
        { name: "job_failed", properties: { toolSlug: "merge-pdf", errorCategory: "password_required" } },
      ],
    });
    const counts = await usage.dimensionCounts(
      { from: new Date(NOW.getTime() - 60_000), to: new Date(NOW.getTime() + 60_000) },
      "errorCategory",
      ["job_failed"],
    );
    expect(counts).toEqual([{ value: "password_required", count: 1 }]);
  });

  it("refuses a category outside the closed union, so a prober cannot label the dashboard", async () => {
    // `job_failed` is client-ingestible: whatever it carries came off the wire.
    // An unknown value counts as unclassified rather than becoming a label.
    await service().ingest({
      actor: GUEST,
      events: [{ name: "job_failed", properties: { errorCategory: "PWNED — see admin@example.com" } }],
    });
    const [row] = usage.recordedEvents();
    expect(row.errorCategory).toBeNull();
  });

  it("leaves the column null for every other event, including ones that declare the dimension", async () => {
    // Only the browser's own failure event fills it. `tool_processing_completed`
    // declares the same dimension and is written by the worker; a client cannot
    // post it at all, and nothing else may populate a failure column.
    await service().ingest({
      actor: USER,
      events: [
        { name: "download", properties: { format: "pdf", errorCategory: "corrupt_document" } },
        { name: "job_succeeded", properties: { errorCategory: "corrupt_document" } },
      ],
    });
    expect(usage.recordedEvents().map((r) => r.errorCategory)).toEqual([null, null]);
  });
});
