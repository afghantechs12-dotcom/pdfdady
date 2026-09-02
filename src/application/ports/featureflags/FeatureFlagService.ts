/**
 * FeatureFlagService port — the application's read-side flag API.
 *
 * Implementations back this with the FeatureFlagRepository (DB) plus an
 * in-process cache, and degrade gracefully (default-disabled) if the
 * persistence layer is unavailable — so the app runs even when the DB is down.
 */
export interface IFeatureFlagService {
  /** True when flag `key` exists and is enabled. False otherwise (incl. errors). */
  isEnabled(key: string): Promise<boolean>;
  /** The flag's JSON-decoded `value`, or null if missing/disabled/no value. */
  getValue<T = string>(key: string): Promise<T | null>;
  /** Forces a cache refresh on next read (e.g. after an admin edit). */
  refresh(key?: string): Promise<void>;
}
