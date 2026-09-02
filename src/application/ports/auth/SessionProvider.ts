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
}
