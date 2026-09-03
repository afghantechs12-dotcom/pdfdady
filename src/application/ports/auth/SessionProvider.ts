import type { UserSession } from "@/src/domain/entities/UserSession";

/**
 * SessionProvider port — issues + verifies opaque session tokens. The Local
 * implementation stores sessions in the `sessions` table; the Clerk adapter
 * would defer to Clerk's session JWTs. The application authenticates requests
 * by calling `get(token)`; tokens are carried in the `pdfdadi_session` cookie.
 */
export interface ISessionProvider {
  create(userId: string, ttlSeconds?: number): Promise<UserSession>;
  get(token: string): Promise<UserSession | null>;
  delete(token: string): Promise<void>;
  /**
   * Deletes every session that expired before `now`, returning the count.
   *
   * Required rather than optional, and for the same reason the retention
   * handler takes its save-intent repository as a required dependency: `get`
   * already refuses an expired token, so nothing in the request path ever
   * needs this and an optional method would simply never be implemented while
   * the table grew forever. A provider that owns its own session lifecycle
   * (Clerk) returns 0 and says so.
   */
  pruneExpired(now: Date): Promise<number>;
}
