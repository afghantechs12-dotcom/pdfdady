import type { PrismaClient } from "@prisma/client";
import { hashPassword } from "@/lib/admin/passwords";
import type { User } from "@/src/domain/entities/User";
import type { UserSession } from "@/src/domain/entities/UserSession";
import type { IUserProvider } from "@/src/application/ports/auth/UserProvider";
import type { ISessionProvider } from "@/src/application/ports/auth/SessionProvider";
import { DomainError } from "@/src/domain/errors";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  isValidEmail,
  normalizeEmail,
  normalizeName,
} from "./authValidation";
import { provisionPersonalAccount } from "./AccountProvisioningService";

/** Cookie name for the user session (kept separate from the M1 admin cookie). */
export const USER_SESSION_COOKIE = "pdfdadi_session";

/** Default session lifetime, and the extended lifetime for "remember me". */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
export const SESSION_SHORT_MAX_AGE = 60 * 60 * 12; // 12 hours

export interface AuthResult {
  user: User;
  session: UserSession;
}

export interface RegisterInput {
  email: string;
  password: string;
  name?: string | null;
}

/**
 * Application service for the Local auth flow: register / login / logout / me.
 *
 * Depends on the IUserProvider + ISessionProvider ports (not on Prisma or
 * Clerk) for identity, so the identity provider can change without touching
 * this. It additionally takes a PrismaClient purely to run tenant provisioning
 * transactionally on registration. Password hashing reuses M1's scrypt helper
 * (`lib/admin/passwords`).
 *
 * Email is normalized at this boundary so that every downstream lookup, and the
 * unique index on `users.email`, agree on one canonical form.
 */
export class AuthService {
  constructor(
    private readonly users: IUserProvider,
    private readonly sessions: ISessionProvider,
    private readonly prisma: PrismaClient,
  ) {}

  /**
   * Registers a local user and provisions their personal tenant.
   *
   * Provisioning runs inside `provisionPersonalAccount`, which is idempotent —
   * a retried signup converges on one Organization and one default Workspace
   * instead of creating duplicates.
   */
  async register(input: RegisterInput): Promise<AuthResult> {
    const email = normalizeEmail(input.email);
    const name = input.name == null ? null : normalizeName(input.name) || null;

    if (!isValidEmail(email)) {
      throw new DomainError("Enter a valid email address.");
    }
    if (input.password.length < MIN_PASSWORD_LENGTH) {
      throw new DomainError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    if (input.password.length > MAX_PASSWORD_LENGTH) {
      throw new DomainError(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
    }
    if (await this.users.getByEmail(email)) {
      throw new DomainError("Email is already registered.");
    }

    // createLocal also translates a unique-violation into the same DomainError,
    // which closes the race between the check above and this insert.
    const user = await this.users.createLocal(email, hashPassword(input.password), name);
    await provisionPersonalAccount(this.prisma, user.id, user.email, user.name);
    const session = await this.sessions.create(user.id, SESSION_MAX_AGE);
    return { user, session };
  }

  /**
   * Verifies credentials and issues a fresh session.
   *
   * Returns null for every failure mode (unknown email, wrong password,
   * external identity) so callers cannot distinguish them and leak which
   * addresses are registered.
   */
  async login(
    email: string,
    password: string,
    options: { rememberMe?: boolean } = {},
  ): Promise<AuthResult | null> {
    const user = await this.users.verifyCredentials(normalizeEmail(email), password);
    if (!user) return null;
    // A brand-new session token per login is session rotation: a token observed
    // before authentication can never become an authenticated one (session
    // fixation). Provisioning is repaired here too, so accounts created before
    // this service provisioned tenants can still reach /workspaces.
    await provisionPersonalAccount(this.prisma, user.id, user.email, user.name);
    const ttl = options.rememberMe ? SESSION_MAX_AGE : SESSION_SHORT_MAX_AGE;
    const session = await this.sessions.create(user.id, ttl);
    return { user, session };
  }

  async logout(token: string): Promise<void> {
    await this.sessions.delete(token);
  }

  async getMe(token: string): Promise<User | null> {
    const session = await this.sessions.get(token);
    if (!session) return null;
    return this.users.getById(session.userId);
  }
}
