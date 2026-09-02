import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/admin/passwords";
import { AuthService, SESSION_MAX_AGE, SESSION_SHORT_MAX_AGE } from "./AuthService";
import { DomainError } from "@/src/domain/errors";
import { normalizeEmail } from "./authValidation";
import type { User } from "@/src/domain/entities/User";
import type { UserSession } from "@/src/domain/entities/UserSession";
import type { IUserProvider } from "@/src/application/ports/auth/UserProvider";
import type { ISessionProvider } from "@/src/application/ports/auth/SessionProvider";
import type { PrismaClient } from "@prisma/client";

// AuthService calls provisionPersonalAccount after register/login. Tenant
// provisioning has its own dedicated suite against a real database; here it is
// stubbed so these tests stay focused on credential and session behaviour.
const provisionSpy = vi.hoisted(() => vi.fn());
vi.mock("./AccountProvisioningService", () => ({
  provisionPersonalAccount: provisionSpy,
}));

/** In-memory IUserProvider that mirrors LocalUserProvider's semantics. */
class FakeUserProvider implements IUserProvider {
  private readonly users = new Map<string, User>();
  private readonly byEmail = new Map<string, User>();
  private seq = 0;

  async getById(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }
  async getByEmail(email: string): Promise<User | null> {
    return this.byEmail.get(normalizeEmail(email)) ?? null;
  }
  async createLocal(email: string, passwordHash: string, name: string | null = null): Promise<User> {
    const key = normalizeEmail(email);
    if (this.byEmail.has(key)) throw new DomainError("Email is already registered.");
    this.seq += 1;
    const u: User = {
      id: `u${this.seq}`,
      email: key,
      name,
      provider: "local",
      providerExternalId: null,
      passwordHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.users.set(u.id, u);
    this.byEmail.set(key, u);
    return u;
  }
  async createExternal(): Promise<User> {
    throw new Error("not used");
  }
  async verifyCredentials(email: string, password: string): Promise<User | null> {
    const u = this.byEmail.get(normalizeEmail(email));
    if (!u || !u.passwordHash) return null;
    return verifyPassword(password, u.passwordHash) ? u : null;
  }
}

/** In-memory ISessionProvider that records the requested TTLs. */
class FakeSessionProvider implements ISessionProvider {
  private readonly sessions = new Map<string, UserSession>();
  private seq = 0;
  readonly ttls: number[] = [];

  async create(userId: string, ttlSeconds = 60): Promise<UserSession> {
    this.ttls.push(ttlSeconds);
    this.seq += 1;
    const s: UserSession = {
      id: `s${this.seq}`,
      userId,
      token: `tok${this.seq}`,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      createdAt: new Date(),
    };
    this.sessions.set(s.token, s);
    return s;
  }
  async get(token: string): Promise<UserSession | null> {
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.expiresAt < new Date()) return null;
    return s;
  }
  async delete(token: string): Promise<void> {
    this.sessions.delete(token);
  }
}

describe("AuthService (local flow)", () => {
  let users: FakeUserProvider;
  let sessions: FakeSessionProvider;
  let auth: AuthService;

  beforeEach(() => {
    provisionSpy.mockReset();
    provisionSpy.mockResolvedValue({ organizationId: "org1", workspaceId: "ws1", created: true });
    users = new FakeUserProvider();
    sessions = new FakeSessionProvider();
    auth = new AuthService(users, sessions, {} as unknown as PrismaClient);
  });

  it("registers a new user and creates a session", async () => {
    const { user, session } = await auth.register({ email: "a@b.co", password: "password123" });
    expect(user.email).toBe("a@b.co");
    expect(user.passwordHash).toBeTruthy(); // stored hash (not the plaintext)
    expect(session.token).toBeTruthy();
    expect(session.userId).toBe(user.id);
  });

  it("stores the normalized email and display name", async () => {
    const { user } = await auth.register({
      email: "  Ada@Example.COM ",
      password: "password123",
      name: "  Ada   Lovelace ",
    });
    expect(user.email).toBe("ada@example.com");
    expect(user.name).toBe("Ada Lovelace");
  });

  it("provisions the personal tenant on registration", async () => {
    const { user } = await auth.register({ email: "a@b.co", password: "password123" });
    expect(provisionSpy).toHaveBeenCalledTimes(1);
    expect(provisionSpy).toHaveBeenCalledWith(expect.anything(), user.id, "a@b.co", null);
  });

  it("rejects a duplicate email regardless of casing or padding", async () => {
    await auth.register({ email: "a@b.co", password: "password123" });
    await expect(auth.register({ email: "a@b.co", password: "password123" })).rejects.toThrow(DomainError);
    await expect(auth.register({ email: " A@B.CO ", password: "password123" })).rejects.toThrow(
      /already registered/,
    );
  });

  it("rejects a short password", async () => {
    await expect(auth.register({ email: "a@b.co", password: "short" })).rejects.toThrow(/8 characters/);
  });

  it("rejects an over-long password", async () => {
    await expect(
      auth.register({ email: "a@b.co", password: "a".repeat(129) }),
    ).rejects.toThrow(/at most/);
  });

  it("rejects a malformed email", async () => {
    await expect(auth.register({ email: "not-an-email", password: "password123" })).rejects.toThrow(
      DomainError,
    );
  });

  it("logs in with valid credentials", async () => {
    await auth.register({ email: "a@b.co", password: "password123" });
    const res = await auth.login("a@b.co", "password123");
    expect(res).not.toBeNull();
    expect(res!.user.email).toBe("a@b.co");
    expect(res!.session.token).toBeTruthy();
  });

  it("logs in with a differently-cased email", async () => {
    await auth.register({ email: "a@b.co", password: "password123" });
    expect(await auth.login("  A@B.CO ", "password123")).not.toBeNull();
  });

  it("rejects login with the wrong password", async () => {
    await auth.register({ email: "a@b.co", password: "password123" });
    expect(await auth.login("a@b.co", "wrong-password")).toBeNull();
  });

  it("returns null (not an error) for an unknown email", async () => {
    expect(await auth.login("nobody@example.com", "password123")).toBeNull();
  });

  it("rotates the session token on every login", async () => {
    const { session: registered } = await auth.register({ email: "a@b.co", password: "password123" });
    const first = await auth.login("a@b.co", "password123");
    const second = await auth.login("a@b.co", "password123");
    // A token seen before authenticating can never become an authenticated one.
    expect(first!.session.token).not.toBe(registered.token);
    expect(second!.session.token).not.toBe(first!.session.token);
  });

  it("uses a short session by default and a long one for remember-me", async () => {
    await auth.register({ email: "a@b.co", password: "password123" });
    sessions.ttls.length = 0;
    await auth.login("a@b.co", "password123");
    expect(sessions.ttls.at(-1)).toBe(SESSION_SHORT_MAX_AGE);
    await auth.login("a@b.co", "password123", { rememberMe: true });
    expect(sessions.ttls.at(-1)).toBe(SESSION_MAX_AGE);
  });

  it("getMe resolves the user from a session token", async () => {
    const { user, session } = await auth.register({ email: "a@b.co", password: "password123" });
    const me = await auth.getMe(session.token);
    expect(me?.id).toBe(user.id);
    expect(await auth.getMe("bad-token")).toBeNull();
  });

  it("logout deletes the session so the token stops resolving", async () => {
    const { session } = await auth.register({ email: "a@b.co", password: "password123" });
    await auth.logout(session.token);
    expect(await auth.getMe(session.token)).toBeNull();
  });

  it("the stored hash is not the plaintext and verifies", async () => {
    const { user } = await auth.register({ email: "a@b.co", password: "password123" });
    expect(user.passwordHash).not.toBe("password123");
    expect(verifyPassword("password123", user.passwordHash!)).toBe(true);
    expect(hashPassword("password123")).not.toBe(user.passwordHash); // unique salt
  });
});
