import { beforeEach, describe, expect, it } from "vitest";
import { FeatureFlagService } from "./FeatureFlagService";
import { InMemoryFeatureFlagRepository } from "@/src/infrastructure/featureflags/InMemoryFeatureFlagRepository";
import { ConsoleLogger } from "@/src/infrastructure/logging/ConsoleLogger";
import type { IFeatureFlagRepository } from "@/src/application/ports/repositories/FeatureFlagRepository";

const logger = () => new ConsoleLogger("error");

describe("FeatureFlagService", () => {
  let repo: InMemoryFeatureFlagRepository;
  let service: FeatureFlagService;

  beforeEach(() => {
    repo = new InMemoryFeatureFlagRepository();
    // ttl 0 → cache expires immediately, so every read hits the repo (fresh).
    service = new FeatureFlagService(repo, logger(), 0);
  });

  it("returns false / null for unknown flags", async () => {
    expect(await service.isEnabled("nope")).toBe(false);
    expect(await service.getValue("nope")).toBeNull();
  });

  it("reflects an enabled flag", async () => {
    await repo.upsert({ key: "k", enabled: true });
    expect(await service.isEnabled("k")).toBe(true);
  });

  it("parses JSON values", async () => {
    await repo.upsert({ key: "k", enabled: true, value: JSON.stringify({ rollout: 0.5 }) });
    expect(await service.getValue<{ rollout: number }>("k")).toEqual({ rollout: 0.5 });
  });

  it("returns null value for a disabled flag even if it has a value", async () => {
    await repo.upsert({ key: "k", enabled: false, value: JSON.stringify(1) });
    expect(await service.getValue("k")).toBeNull();
  });

  it("caches within ttl and refreshes on demand", async () => {
    const cached = new FeatureFlagService(repo, logger(), 10_000);
    await repo.upsert({ key: "k", enabled: true });
    expect(await cached.isEnabled("k")).toBe(true);

    await repo.upsert({ key: "k", enabled: false });
    // Still cached → stale true.
    expect(await cached.isEnabled("k")).toBe(true);

    await cached.refresh("k");
    expect(await cached.isEnabled("k")).toBe(false);
  });

  it("degrades gracefully (disabled) when the repository throws", async () => {
    const throwing: IFeatureFlagRepository = {
      get: async () => {
        throw new Error("db down");
      },
      getAll: async () => [],
      upsert: async () => {
        throw new Error("db down");
      },
      delete: async () => {},
    };
    const svc = new FeatureFlagService(throwing, logger(), 1_000);
    expect(await svc.isEnabled("k")).toBe(false);
    expect(await svc.getValue("k")).toBeNull();
  });
});
