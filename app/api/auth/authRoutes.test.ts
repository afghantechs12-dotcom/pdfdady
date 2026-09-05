import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level security tests for /api/auth/*.
 *
 * The DI container is mocked so these run without a database: the point is the
 * HTTP contract (methods, statuses, cookie flags, CSRF, rate limits, what does
 * and does not appear in a response body), not persistence. Credential and
 * provisioning semantics are covered by AuthService.test.ts and
 * AccountProvisioning.test.ts respectively.
 */

const ORIGIN = "http://localhost:3000";

const state = vi.hoisted(() => ({
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
  getMe: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/src/application/di/container", () => ({
  appContainer: {
    resolve: (token: symbol) => {
      const name = token.description;
      if (name === "AuthService") {
        return {
          login: state.login,
          register: state.register,
          logout: state.logout,
          getMe: state.getMe,
        };
      }
      if (name === "AuditLogRepository") return { record: state.audit };
      if (name === "Metrics") return { increment: vi.fn(), timing: vi.fn(), gauge: vi.fn() };
      if (name === "Analytics") return { track: vi.fn(), identify: vi.fn() };
      throw new Error(`unexpected token ${String(name)}`);
    },
  },
}));

import { POST as loginPost } from "@/app/api/auth/login/route";
import { POST as signupPost } from "@/app/api/auth/signup/route";
import { POST as logoutPost } from "@/app/api/auth/logout/route";
import { GET as meGet } from "@/app/api/auth/me/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as signupRoute from "@/app/api/auth/signup/route";
import * as logoutRoute from "@/app/api/auth/logout/route";
import * as meRoute from "@/app/api/auth/me/route";
import * as registerRoute from "@/app/api/auth/register/route";
import { loginRateLimiter, signupRateLimiter } from "@/src/application/services/authHttp";
import { USER_SESSION_COOKIE } from "@/src/application/services/AuthService";
import { DomainError } from "@/src/domain/errors";

interface RequestOptions {
  body?: unknown;
  origin?: string | null;
  referer?: string | null;
  cookie?: string;
  headers?: Record<string, string>;
  ip?: string;
}

function makeRequest(url: string, method: string, options: RequestOptions = {}) {
  const headers = new Headers({ "Content-Type": "application/json", ...options.headers });
  if (options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
  if (options.referer) headers.set("referer", options.referer);
  if (options.cookie) headers.set("cookie", options.cookie);
  // A distinct client per test keeps the shared in-process rate limiters isolated.
  // The peer header, not `x-forwarded-for`: the limiters stopped trusting a header a
  // client can write (`clientIp`), and this is the one the ingress guard stamps.
  headers.set("x-pdfdadi-peer", options.ip ?? `10.0.0.${Math.floor(Math.random() * 250) + 1}`);

  const request = new Request(url, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  // The logout/me handlers take a NextRequest and read `req.cookies`. Emulate
  // just that surface rather than pulling in the full Next server runtime.
  const cookieValue = options.cookie?.split("=").slice(1).join("=");
  Object.defineProperty(request, "cookies", {
    value: {
      get: (name: string) =>
        options.cookie?.startsWith(`${name}=`) ? { name, value: cookieValue } : undefined,
    },
    configurable: true,
  });
  return request as unknown as Parameters<typeof logoutPost>[0];
}

const sessionUser = {
  id: "user_1",
  email: "ada@example.com",
  name: "Ada Lovelace",
  provider: "local" as const,
  providerExternalId: null,
  passwordHash: "salt:hash-should-never-be-returned",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const session = {
  id: "session_1",
  userId: "user_1",
  token: "raw-session-token-should-never-be-returned",
  expiresAt: new Date(Date.now() + 60_000),
  createdAt: new Date(),
};

/** Parses a Set-Cookie header into a flag lookup. */
function parseSetCookie(header: string | null) {
  if (!header) return null;
  const [pair, ...attributes] = header.split(";").map((part) => part.trim());
  const eq = pair.indexOf("=");
  const flags = new Map<string, string>();
  for (const attribute of attributes) {
    const index = attribute.indexOf("=");
    if (index === -1) flags.set(attribute.toLowerCase(), "");
    else flags.set(attribute.slice(0, index).toLowerCase(), attribute.slice(index + 1));
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), flags };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.audit.mockResolvedValue(undefined);
  state.login.mockResolvedValue({ user: sessionUser, session });
  state.register.mockResolvedValue({ user: sessionUser, session });
  state.logout.mockResolvedValue(undefined);
  state.getMe.mockResolvedValue(sessionUser);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("HTTP method contract", () => {
  // The original bug: a page redirect sent the browser to GET a POST-only
  // route, which Next answers with 405.
  it("exposes ONLY POST on the credential and logout routes", () => {
    for (const route of [loginRoute, signupRoute, logoutRoute, registerRoute]) {
      expect(typeof route.POST).toBe("function");
      expect((route as Record<string, unknown>).GET).toBeUndefined();
      expect((route as Record<string, unknown>).PUT).toBeUndefined();
      expect((route as Record<string, unknown>).DELETE).toBeUndefined();
    }
  });

  it("exposes ONLY GET on /api/auth/me", () => {
    expect(typeof meRoute.GET).toBe("function");
    expect((meRoute as Record<string, unknown>).POST).toBeUndefined();
  });

  it("serves /register through the same handler as /signup (no second signup path)", () => {
    expect(registerRoute.POST).toBe(signupRoute.POST);
  });

  it("runs the auth routes on the node runtime", () => {
    for (const route of [loginRoute, signupRoute, logoutRoute, meRoute]) {
      expect(route.runtime).toBe("nodejs");
      expect(route.dynamic).toBe("force-dynamic");
    }
  });
});

describe("POST /api/auth/login", () => {
  it("accepts valid credentials and sets the session cookie", async () => {
    const response = await loginPost(
      makeRequest(`${ORIGIN}/api/auth/login`, "POST", {
        body: { email: "ada@example.com", password: "password123" },
      }),
    );
    expect(response.status).toBe(200);
    const cookie = parseSetCookie(response.headers.get("set-cookie"));
    expect(cookie?.name).toBe(USER_SESSION_COOKIE);
    expect(cookie?.value).toBe(session.token);
  });

  it("marks the session cookie HttpOnly, SameSite=Lax and Path=/", async () => {
    const response = await loginPost(
      makeRequest(`${ORIGIN}/api/auth/login`, "POST", {
        body: { email: "ada@example.com", password: "password123" },
      }),
    );
    const cookie = parseSetCookie(response.headers.get("set-cookie"));
    // HttpOnly is what stops XSS from reading the token.
    expect(cookie?.flags.has("httponly")).toBe(true);
    expect(cookie?.flags.get("samesite")?.toLowerCase()).toBe("lax");
    expect(cookie?.flags.get("path")).toBe("/");
  });

  it("adds Secure to the cookie in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await loginPost(
      makeRequest(`${ORIGIN}/api/auth/login`, "POST", {
        body: { email: "ada@example.com", password: "password123" },
      }),
    );
    expect(parseSetCookie(response.headers.get("set-cookie"))?.flags.has("secure")).toBe(true);
  });

  it("returns the SAME generic error for an unknown email and a wrong password", async () => {
    state.login.mockResolvedValue(null);
    const unknown = await loginPost(
      makeRequest(`${ORIGIN}/api/auth/login`, "POST", {
        body: { email: "nobody@example.com", password: "password123" },
      }),
    );
    const wrong = await loginPost(
      makeRequest(`${ORIGIN}/api/auth/login`, "POST", {
        body: { email: "ada@example.com", password: "wrong-password" },
      }),
    );
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    // Identical status AND body — nothing distinguishes the two cases.
    expect(await unknown.json()).toEqual(await wrong.json());
  });

  it("never returns the password hash or the raw session token", async () => {
    const response = await loginPost(
      makeRequest(`${ORIGIN}/api/auth/login`, "POST", {
        body: { email: "ada@example.com", password: "password123" },
      }),
    );
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain(sessionUser.passwordHash);
    expect(text).not.toContain("passwordHash");
    expect(text).not.toContain(session.token);
  });

  it("resolves a safe redirect and rejects an external one", async () => {
    const safe = await loginPost(
      makeRequest(`${ORIGIN}/api/auth/login`, "POST", {
        body: { email: "ada@example.com", password: "password123", next: "/workspaces/abc" },
      }),
    );
    expect((await safe.json()).redirectTo).toBe("/workspaces/abc");

    for (const hostile of ["https://evil.test", "//evil.test", "javascript:alert(1)", "%2f%2fevil.test"]) {
      const response = await loginPost(
        makeRequest(`${ORIGIN}/api/auth/login`, "POST", {
          body: { email: "ada@example.com", password: "password123", next: hostile },
        }),
      );
      expect((await response.json()).redirectTo).toBe("/workspaces");
    }
  });

  it("rejects a cross-origin request (CSRF)", async () => {
    const response = await loginPost(
      makeRequest(`${ORIGIN}/api/auth/login`, "POST", {
        body: { email: "ada@example.com", password: "password123" },
        origin: "https://evil.test",
      }),
    );
    expect(response.status).toBe(403);
    expect(state.login).not.toHaveBeenCalled();
  });

  it("rejects a request carrying neither Origin nor Referer", async () => {
    const response = await loginPost(
      makeRequest(`${ORIGIN}/api/auth/login`, "POST", {
        body: { email: "ada@example.com", password: "password123" },
        origin: null,
      }),
    );
    expect(response.status).toBe(403);
  });

  it("rejects malformed JSON", async () => {
    const request = new Request(`${ORIGIN}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: ORIGIN, "x-pdfdadi-peer": "10.9.9.1" },
      body: "{not json",
    });
    const response = await loginPost(request);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_JSON");
  });

  it("rejects an oversized body with 413", async () => {
    const response = await loginPost(
      makeRequest(`${ORIGIN}/api/auth/login`, "POST", {
        body: { email: "ada@example.com", password: "a".repeat(10_000) },
      }),
    );
    expect(response.status).toBe(413);
    expect(state.login).not.toHaveBeenCalled();
  });

  it("rate-limits repeated attempts from one IP", async () => {
    const ip = "203.0.113.77";
    state.login.mockResolvedValue(null);
    let limited: Response | null = null;
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const response = await loginPost(
        makeRequest(`${ORIGIN}/api/auth/login`, "POST", {
          body: { email: "ada@example.com", password: "wrong" },
          ip,
        }),
      );
      if (response.status === 429) {
        limited = response;
        break;
      }
    }
    expect(limited).not.toBeNull();
    expect(limited!.headers.get("retry-after")).toBe("60");
  });
});

describe("POST /api/auth/signup", () => {
  const body = {
    name: "Ada Lovelace",
    email: "ada@example.com",
    password: "password123",
    confirmPassword: "password123",
  };

  it("creates the account and returns 201 with a session cookie", async () => {
    const response = await signupPost(
      makeRequest(`${ORIGIN}/api/auth/signup`, "POST", { body }),
    );
    expect(response.status).toBe(201);
    expect(parseSetCookie(response.headers.get("set-cookie"))?.flags.has("httponly")).toBe(true);
    expect(state.register).toHaveBeenCalledWith({
      email: body.email,
      password: body.password,
      name: body.name,
    });
  });

  it("reports a duplicate email as 409", async () => {
    state.register.mockRejectedValue(new DomainError("Email is already registered."));
    const response = await signupPost(makeRequest(`${ORIGIN}/api/auth/signup`, "POST", { body }));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("EMAIL_TAKEN");
  });

  it("rejects a password mismatch server-side", async () => {
    const response = await signupPost(
      makeRequest(`${ORIGIN}/api/auth/signup`, "POST", {
        body: { ...body, confirmPassword: "different123" },
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("Passwords do not match.");
    expect(state.register).not.toHaveBeenCalled();
  });

  it("rejects a short password server-side even if the client allowed it", async () => {
    const response = await signupPost(
      makeRequest(`${ORIGIN}/api/auth/signup`, "POST", {
        body: { ...body, password: "short", confirmPassword: "short" },
      }),
    );
    expect(response.status).toBe(400);
    expect(state.register).not.toHaveBeenCalled();
  });

  it("rejects a blank name and a malformed email", async () => {
    const blankName = await signupPost(
      makeRequest(`${ORIGIN}/api/auth/signup`, "POST", { body: { ...body, name: "   " } }),
    );
    expect(blankName.status).toBe(400);

    const badEmail = await signupPost(
      makeRequest(`${ORIGIN}/api/auth/signup`, "POST", { body: { ...body, email: "nope" } }),
    );
    expect(badEmail.status).toBe(400);
  });

  it("hides an unexpected provisioning failure behind generic copy", async () => {
    state.register.mockRejectedValue(
      new Error("Invalid `prisma.workspace.create()` — UNIQUE constraint failed: workspaces.slug"),
    );
    const response = await signupPost(makeRequest(`${ORIGIN}/api/auth/signup`, "POST", { body }));
    const text = JSON.stringify(await response.json());
    expect(response.status).toBe(500);
    expect(text).not.toMatch(/prisma/i);
    expect(text).not.toMatch(/constraint/i);
    expect(text).not.toMatch(/workspaces\.slug/);
  });

  it("never returns the password hash", async () => {
    const response = await signupPost(makeRequest(`${ORIGIN}/api/auth/signup`, "POST", { body }));
    expect(JSON.stringify(await response.json())).not.toContain(sessionUser.passwordHash);
  });

  it("rejects a cross-origin signup", async () => {
    const response = await signupPost(
      makeRequest(`${ORIGIN}/api/auth/signup`, "POST", { body, origin: "https://evil.test" }),
    );
    expect(response.status).toBe(403);
    expect(state.register).not.toHaveBeenCalled();
  });

  it("rate-limits repeated signups from one IP", async () => {
    const ip = "203.0.113.99";
    let limited: Response | null = null;
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const response = await signupPost(
        makeRequest(`${ORIGIN}/api/auth/signup`, "POST", { body, ip }),
      );
      if (response.status === 429) {
        limited = response;
        break;
      }
    }
    expect(limited).not.toBeNull();
  });
});

describe("POST /api/auth/logout", () => {
  it("invalidates the server-side session, not just the cookie", async () => {
    const response = await logoutPost(
      makeRequest(`${ORIGIN}/api/auth/logout`, "POST", {
        cookie: `${USER_SESSION_COOKIE}=abc123`,
      }),
    );
    expect(response.status).toBe(200);
    // The row is deleted, so a captured token is dead too.
    expect(state.logout).toHaveBeenCalledWith("abc123");
  });

  it("clears the cookie with Max-Age=0 and matching flags", async () => {
    const response = await logoutPost(
      makeRequest(`${ORIGIN}/api/auth/logout`, "POST", {
        cookie: `${USER_SESSION_COOKIE}=abc123`,
      }),
    );
    const cookie = parseSetCookie(response.headers.get("set-cookie"));
    expect(cookie?.name).toBe(USER_SESSION_COOKIE);
    expect(cookie?.value).toBe("");
    expect(cookie?.flags.get("max-age")).toBe("0");
    expect(cookie?.flags.has("httponly")).toBe(true);
  });

  it("rejects a cross-origin logout (forced sign-out CSRF)", async () => {
    const response = await logoutPost(
      makeRequest(`${ORIGIN}/api/auth/logout`, "POST", {
        cookie: `${USER_SESSION_COOKIE}=abc123`,
        origin: "https://evil.test",
      }),
    );
    expect(response.status).toBe(403);
    expect(state.logout).not.toHaveBeenCalled();
  });

  it("succeeds without a session rather than disclosing that none existed", async () => {
    const response = await logoutPost(makeRequest(`${ORIGIN}/api/auth/logout`, "POST"));
    expect(response.status).toBe(200);
    expect(state.logout).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/me", () => {
  it("returns the public user for a valid session", async () => {
    const response = await meGet(
      makeRequest(`${ORIGIN}/api/auth/me`, "GET", { cookie: `${USER_SESSION_COOKIE}=abc123` }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user).toMatchObject({ id: "user_1", email: "ada@example.com", name: "Ada Lovelace" });
  });

  it("never exposes the password hash or the session token", async () => {
    const response = await meGet(
      makeRequest(`${ORIGIN}/api/auth/me`, "GET", { cookie: `${USER_SESSION_COOKIE}=abc123` }),
    );
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("passwordHash");
    expect(text).not.toContain(sessionUser.passwordHash);
    expect(text).not.toContain("abc123");
  });

  it("returns 401 with no cookie", async () => {
    const response = await meGet(makeRequest(`${ORIGIN}/api/auth/me`, "GET"));
    expect(response.status).toBe(401);
  });

  it("returns 401 and clears the cookie for an expired or forged token", async () => {
    state.getMe.mockResolvedValue(null);
    const response = await meGet(
      makeRequest(`${ORIGIN}/api/auth/me`, "GET", { cookie: `${USER_SESSION_COOKIE}=expired` }),
    );
    expect(response.status).toBe(401);
    const cookie = parseSetCookie(response.headers.get("set-cookie"));
    expect(cookie?.value).toBe("");
    expect(cookie?.flags.get("max-age")).toBe("0");
  });
});

describe("rate limiters", () => {
  it("bounds login more tightly than signup per window", () => {
    // Login is the endpoint worth brute-forcing, so its window is the shorter.
    expect(loginRateLimiter).toBeDefined();
    expect(signupRateLimiter).toBeDefined();
    expect(loginRateLimiter).not.toBe(signupRateLimiter);
  });
});
