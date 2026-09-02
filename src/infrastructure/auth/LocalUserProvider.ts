import { PrismaClient, Prisma } from "@prisma/client";
import { hashPassword, verifyPassword } from "@/lib/admin/passwords";
import { normalizeEmail } from "@/src/application/services/authValidation";
import type { User, IdentityProvider } from "@/src/domain/entities/User";
import type { IUserProvider } from "@/src/application/ports/auth/UserProvider";
import { DomainError } from "@/src/domain/errors";

type UserRow = {
  id: string;
  email: string;
  name: string | null;
  provider: string;
  providerExternalId: string | null;
  passwordHash: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toDomain(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    provider: row.provider as IdentityProvider,
    providerExternalId: row.providerExternalId,
    passwordHash: row.passwordHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * A well-formed scrypt hash of a value nobody can supply, used to equalize the
 * cost of "no such user" against "wrong password". Computed once at module load
 * so the per-request work is a single scrypt verify either way.
 */
const DUMMY_HASH = hashPassword("pdfdadi::timing-equalizer::not-a-real-password");

/**
 * Local IUserProvider — stores users in the `users` table with a scrypt
 * password hash (reusing M1's `lib/admin/passwords`). Clerk users store null.
 *
 * Every email is normalized (NFKC + trim + lowercase) on write AND on read, so
 * "Ada@Example.com" and "ada@example.com" are the same account and the unique
 * index on `users.email` genuinely prevents duplicate registrations.
 */
export class LocalUserProvider implements IUserProvider {
  constructor(private readonly prisma: PrismaClient) {}

  async getById(id: string): Promise<User | null> {
    const r = await this.prisma.user.findUnique({ where: { id } });
    return r ? toDomain(r) : null;
  }

  async getByEmail(email: string): Promise<User | null> {
    const r = await this.prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
    return r ? toDomain(r) : null;
  }

  async createLocal(email: string, passwordHash: string, name: string | null = null): Promise<User> {
    const normalized = normalizeEmail(email);
    try {
      const r = await this.prisma.user.create({
        data: { email: normalized, name, provider: "local", passwordHash },
      });
      return toDomain(r);
    } catch (error) {
      // P2002 = unique constraint violation. Relying on the database rather than
      // a preceding SELECT closes the race where two concurrent signups for the
      // same address both observe "not taken" and then both insert.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new DomainError("Email is already registered.");
      }
      throw error;
    }
  }

  async createExternal(
    provider: "clerk",
    externalId: string,
    email: string,
  ): Promise<User> {
    const r = await this.prisma.user.create({
      data: {
        email: normalizeEmail(email),
        name: null,
        provider,
        providerExternalId: externalId,
        passwordHash: null,
      },
    });
    return toDomain(r);
  }

  /**
   * Verifies credentials in constant-ish time.
   *
   * When the user does not exist (or is an external identity with no local
   * password) we still run one scrypt verification against a dummy hash before
   * returning null. Without it, "unknown email" returns in microseconds while
   * "known email, wrong password" takes tens of milliseconds — a difference an
   * attacker can measure to enumerate registered addresses, which would defeat
   * the generic error message the login route returns.
   */
  async verifyCredentials(email: string, password: string): Promise<User | null> {
    const u = await this.getByEmail(email);
    if (!u || u.provider !== "local" || !u.passwordHash) {
      verifyPassword(password, DUMMY_HASH);
      return null;
    }
    return verifyPassword(password, u.passwordHash) ? u : null;
  }
}
