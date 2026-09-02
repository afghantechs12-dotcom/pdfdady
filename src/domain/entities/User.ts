/** Which identity provider owns a user record. */
export type IdentityProvider = "local" | "clerk";

/**
 * User domain entity. `passwordHash` is non-null only for `provider === "local"`
 * (Clerk users authenticate externally and store null). `name` is nullable
 * because it predates the signup form. Domain entities carry no ORM types; the
 * provider adapters map to/from Prisma rows.
 */
export interface User {
  id: string;
  email: string;
  name: string | null;
  provider: IdentityProvider;
  providerExternalId: string | null;
  passwordHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A user with secret/internal fields stripped, safe to return to the client.
 *
 * `passwordHash` is deliberately absent — `toPublicUser` is the only sanctioned
 * way to put a user on the wire, so no route can leak the hash by accident.
 */
export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  provider: IdentityProvider;
  createdAt: Date;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    provider: user.provider,
    createdAt: user.createdAt,
  };
}
