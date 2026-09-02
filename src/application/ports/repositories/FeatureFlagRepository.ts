import type { FeatureFlag } from "@/src/domain/entities/FeatureFlag";

/**
 * FeatureFlagRepository port — persistence abstraction for feature flags.
 *
 * The application depends on this interface; the infrastructure layer provides
 * a Prisma-backed implementation (and an in-memory one for tests/fallback).
 * Swapping the persistence provider never touches this contract or anything
 * that calls it.
 */
export interface FeatureFlagUpsertInput {
  key: string;
  enabled: boolean;
  value?: string | null;
}

export interface IFeatureFlagRepository {
  get(key: string): Promise<FeatureFlag | null>;
  getAll(): Promise<FeatureFlag[]>;
  upsert(input: FeatureFlagUpsertInput): Promise<FeatureFlag>;
  delete(key: string): Promise<void>;
}
