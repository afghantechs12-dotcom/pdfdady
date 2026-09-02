import type { User } from "@/src/domain/entities/User";

/**
 * UserProvider port — the application's user-identity abstraction.
 *
 * The Local implementation stores users in the `users` table with a password
 * hash; the Clerk adapter mirrors users from Clerk webhooks (no password). The
 * application depends only on this interface, so swapping identity providers
 * never touches business logic.
 */
export interface IUserProvider {
  getById(id: string): Promise<User | null>;
  /** Looks up by email; implementations normalize before querying. */
  getByEmail(email: string): Promise<User | null>;
  /**
   * Local: create a user with a password hash. Throws if the email is taken.
   * `name` is the display name captured at signup (null when unknown).
   */
  createLocal(email: string, passwordHash: string, name?: string | null): Promise<User>;
  /** External (Clerk): create/mirror a user from an external identity. */
  createExternal(provider: "clerk", externalId: string, email: string): Promise<User>;
  /** Local credential check → User if valid, null otherwise. Clerk throws. */
  verifyCredentials(email: string, password: string): Promise<User | null>;
}
