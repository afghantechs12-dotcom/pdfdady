import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Proxy-aware CSRF origin validation (Launch Readiness 3.1.1).
 *
 * THE DEFECT THIS FILE EXISTS FOR. `requireSameOrigin` compared the browser's
 * `Origin` against `new URL(request.url).origin`. In a production Next server
 * that value is the server's own BIND address, not the public one — so behind the
 * reverse proxy every same-origin mutation was refused: real production signup
 * answered 403 `CSRF_ORIGIN_REJECTED` while a dev server answered 201 to the
 * byte-identical request. The existing 13 CSRF tests were all green throughout,
 * because they build the Request with the public origin AS its URL, which is only
 * true when nothing sits in front of the server.
 *
 * Every case below therefore uses an INTERNAL request URL and a PUBLIC `Origin`,
 * the shape the old code could not express.
 *
 * ANTI-VACUITY. These tests run with NODE_ENV=production, and in production
 * `getConfig()` THROWS if the deployment gate is unhappy — in which case the
 * trusted-origin set is empty and every rejection assertion below would pass for
 * entirely the wrong reason. `guards the gate` asserts the gate is quiet, and the
 * allow-cases fail loudly if it is not.
 */

const state = vi.hoisted(() => ({
  register: vi.fn(),
  getMe: vi.fn(),
  audit: vi.fn(),
  createWorkspace: vi.fn(),
  listForUser: vi.fn(),
  getRole: vi.fn(),
}));

vi.mock("@/src/application/di/container", () => ({
  appContainer: {
    resolve: (token: symbol) => {
      switch (token.description) {
        case "AuthService":
          return { register: state.register, getMe: state.getMe };
        case "AuditLogRepository":
          return { record: state.audit };
        case "Metrics":
          return { increment: vi.fn(), timing: vi.fn(), gauge: vi.fn() };
        case "Analytics":
          return { track: vi.fn(), identify: vi.fn() };
        case "OrganizationProvider":
          return { listForUser: state.listForUser };
        case "RoleProvider":
          return { getRole: state.getRole };
        case "WorkspaceService":
          return { create: state.createWorkspace };
        default:
          // Other services are resolved eagerly by `workspaceServices()`; only
          // the ones these two routes actually call need behaviour.
          return {};
      }
    },
  },
}));

import { getConfig, _resetConfigForTests } from "@/src/infrastructure/config/env";
import { requireSameOrigin } from "./workspaceCsrf";
import { POST as signupPost } from "@/app/api/auth/signup/route";
import { POST as workspacesPost } from "@/app/api/workspaces/route";
import { USER_SESSION_COOKIE } from "./AuthService";

/** The public origin the browser sees, and the only one production trusts. */
const PUBLIC_ORIGIN = "https://pdfdadi.example";
/** What Next hands a route handler when a proxy terminates TLS in front of it. */
const INTERNAL_URL = `http://127.0.0.1:3000/api/workspaces`;
const INTERNAL_ORIGIN = "http://127.0.0.1:3000";

const env = process.env as unknown as Record<string, string | undefined>;
// Cleared, not just remembered: a variable inherited from the developer's shell
// must not be what decides whether the production gate fires.
const KEYS = [
  "NODE_ENV",
  "NEXT_PHASE",
  "ADMIN_SECRET",
  "PDFDADI_ALLOW_INSECURE_DEV_SECRET",
  "NEXT_PUBLIC_SITE_URL",
  "DATABASE_URL",
  "STORAGE_SIGNING_SECRET",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_PRO",
  "REDIS_URL",
] as const;
const ORIG: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    ORIG[key] = env[key];
    delete env[key];
  }
  vi.clearAllMocks();
  state.register.mockResolvedValue({
    user: {
      id: "user_1",
      email: "ada@pdfdadi.example",
      name: "Ada Lovelace",
      provider: "local" as const,
      providerExternalId: null,
      passwordHash: "salt:hash",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
    session: { id: "s1", userId: "user_1", token: "tok", expiresAt: new Date(Date.now() + 60_000), createdAt: new Date() },
  });
  state.getMe.mockResolvedValue({ id: "user_1", email: "ada@pdfdadi.example", name: "Ada" });
  state.audit.mockResolvedValue(undefined);
  state.listForUser.mockResolvedValue([{ id: "org_1", defaultWorkspaceId: "ws_1" }]);
  state.getRole.mockResolvedValue("owner");
  state.createWorkspace.mockResolvedValue({ id: "ws_2", name: "Launch" });
});

afterEach(() => {
  for (const key of KEYS) {
    if (ORIG[key] === undefined) delete env[key];
    else env[key] = ORIG[key];
  }
  _resetConfigForTests();
});

/** A production deployment the startup gate accepts, served at `siteUrl`. */
function deployBehindProxy(siteUrl: string = PUBLIC_ORIGIN): void {
  env.NODE_ENV = "production";
  // Absolute SQLite file: the only DATABASE_URL shape the production gate accepts,
  // because prisma/schema.prisma declares provider = "sqlite".
  env.DATABASE_URL = "file:/srv/pdfdadi/data/pdfdadi.db";
  env.ADMIN_SECRET = "0123456789abcdef0123456789abcdef";
  env.NEXT_PUBLIC_SITE_URL = siteUrl;
  _resetConfigForTests();
}

function deployInDev(siteUrl = "http://localhost:3000"): void {
  env.NODE_ENV = "development";
  env.NEXT_PUBLIC_SITE_URL = siteUrl;
  _resetConfigForTests();
}

function post(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: "POST", headers });
}

/** Status of the CSRF verdict: 403 when refused, null when the request is let through. */
function verdict(url: string, headers: Record<string, string> = {}): number | null {
  return requireSameOrigin(post(url, headers))?.status ?? null;
}

describe("proxy-aware CSRF — the production defect", () => {
  it("guards the gate: the production config under test is actually valid", () => {
    // Without this, an empty trusted-origin set caused by a gate failure would
    // make every rejection test below green while proving nothing at all.
    deployBehindProxy();
    expect(() => getConfig()).not.toThrow();
    expect(getConfig().isProduction).toBe(true);
    expect(getConfig().siteUrl).toBe(PUBLIC_ORIGIN);
  });

  it("allows the public browser Origin when the request URL is the internal bind origin", () => {
    // THE regression. Old code: expected === "http://127.0.0.1:3000" → 403.
    deployBehindProxy();
    expect(verdict(INTERNAL_URL, { origin: PUBLIC_ORIGIN })).toBeNull();
  });

  it("allows it when the server is exposed directly, with no proxy in front", () => {
    deployBehindProxy();
    expect(verdict(`${PUBLIC_ORIGIN}/api/workspaces`, { origin: PUBLIC_ORIGIN })).toBeNull();
  });

  it("does NOT trust the internal bind origin itself in production", () => {
    // Proves the fix replaced the request-derived origin rather than adding the
    // configured one alongside it. An attacker on the internal network naming
    // the bind origin is not a same-origin browser request.
    deployBehindProxy();
    expect(verdict(INTERNAL_URL, { origin: INTERNAL_ORIGIN })).toBe(403);
  });

  it("accepts a public Referer when Origin is absent, behind the proxy", () => {
    deployBehindProxy();
    expect(verdict(INTERNAL_URL, { referer: `${PUBLIC_ORIGIN}/workspaces/w1?tab=members` })).toBeNull();
  });
});

describe("proxy-aware CSRF — cross-site and look-alike origins", () => {
  beforeEach(() => deployBehindProxy());

  it("sanity: this block's environment does accept the real origin", () => {
    // Local anti-vacuity guard. Every other case here asserts a 403, which is
    // also what a gate failure produces — so one allow-case has to live in the
    // same `beforeEach` to prove the rejections are decisions, not breakage.
    expect(verdict(INTERNAL_URL, { origin: PUBLIC_ORIGIN })).toBeNull();
  });

  it.each([
    ["a plainly foreign origin", "https://evil.example"],
    ["scheme mismatch (http for an https site)", "http://pdfdadi.example"],
    ["wrong port", "https://pdfdadi.example:8443"],
    ["suffix confusion", "https://pdfdadi.example.evil.com"],
    ["prefix confusion", "https://evilpdfdadi.example"],
    ["subdomain confusion", "https://sub.pdfdadi.example"],
    ["a trailing-dot host", "https://pdfdadi.example."],
    ["userinfo pointing elsewhere", "https://pdfdadi.example@evil.example"],
    ["userinfo dressing up the real host", "https://evil.example@pdfdadi.example"],
    ["a path glued on", "https://pdfdadi.example/"],
    ["an opaque origin from a sandboxed iframe", "null"],
    ["a malformed Origin", "not a url"],
    ["an empty-ish Origin", " "],
  ])("rejects %s", (_label, origin) => {
    expect(verdict(INTERNAL_URL, { origin })).toBe(403);
  });

  it("rejects a foreign Referer", () => {
    expect(verdict(INTERNAL_URL, { referer: "https://evil.example/workspaces" })).toBe(403);
  });

  it("rejects a malformed Referer", () => {
    expect(verdict(INTERNAL_URL, { referer: "not a url" })).toBe(403);
  });

  it("still refuses a request with neither Origin nor Referer — policy unchanged", async () => {
    const response = requireSameOrigin(post(INTERNAL_URL))!;
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("CSRF_ORIGIN_REQUIRED");
  });

  it("keeps the rejection code the routes and probes assert on", async () => {
    const response = requireSameOrigin(post(INTERNAL_URL, { origin: "https://evil.example" }))!;
    expect((await response.json()).error.code).toBe("CSRF_ORIGIN_REJECTED");
  });
});

describe("proxy-aware CSRF — forwarded headers are never an authority", () => {
  beforeEach(() => deployBehindProxy());

  // The whole point of a server-configured origin: a client-supplied header must
  // not be able to nominate the origin it is then compared against. If any of
  // these were read, sending both halves would authorize an arbitrary attacker.
  it.each([
    ["x-forwarded-host", { "x-forwarded-host": "evil.example" }],
    ["x-forwarded-proto + host", { "x-forwarded-proto": "https", host: "evil.example" }],
    ["a forged Host alone", { host: "evil.example" }],
    ["RFC 7239 Forwarded", { forwarded: "host=evil.example;proto=https" }],
    ["x-forwarded-host naming the real site", { "x-forwarded-host": "pdfdadi.example" }],
    ["everything at once", {
      host: "evil.example",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
      "x-forwarded-port": "443",
      forwarded: "host=evil.example;proto=https",
      "x-original-host": "evil.example",
    }],
  ])("an evil Origin stays rejected when paired with %s", (_label, forged) => {
    expect(verdict(INTERNAL_URL, { origin: "https://evil.example", ...forged })).toBe(403);
  });

  it("and forged forwarded headers cannot un-authorize a genuine request either", () => {
    // The headers are not sanitized or preferred-if-present; they are not read.
    expect(verdict(INTERNAL_URL, {
      origin: PUBLIC_ORIGIN,
      host: "evil.example",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "http",
    })).toBeNull();
  });
});

describe("proxy-aware CSRF — fail-closed and development behaviour", () => {
  it("refuses everything when production config cannot be read", () => {
    // Gate refuses an unparseable site URL, `getConfig()` throws, and the
    // trusted set is empty — a broken deployment rejects rather than falling
    // back to the request origin.
    deployBehindProxy("not-a-url");
    expect(() => getConfig()).toThrow();
    expect(verdict(INTERNAL_URL, { origin: PUBLIC_ORIGIN })).toBe(403);
    expect(verdict(INTERNAL_URL, { origin: INTERNAL_ORIGIN })).toBe(403);
  });

  it("keeps development working on whatever host and port you browse", () => {
    // Deliberate and unchanged: dev is not gated on NEXT_PUBLIC_SITE_URL, so
    // `next dev` on :3001 or a LAN address must not need it configured first.
    deployInDev();
    expect(verdict("http://localhost:3001/api/workspaces", { origin: "http://localhost:3001" })).toBeNull();
    expect(verdict("http://192.168.1.20:3000/api/workspaces", { origin: "http://192.168.1.20:3000" })).toBeNull();
  });

  it("development also accepts the configured origin, and still rejects a foreign one", () => {
    deployInDev();
    expect(verdict("http://localhost:3001/api/workspaces", { origin: "http://localhost:3000" })).toBeNull();
    expect(verdict("http://localhost:3001/api/workspaces", { origin: "https://evil.example" })).toBe(403);
  });
});

/**
 * Wiring. The seam being correct is not the same as the routes reaching it — a
 * previous slice shipped 26 green policy tests over a consumer that called itself
 * in a loop. These drive the two real handlers.
 */
describe("proxy-aware CSRF — routes behind the proxy", () => {
  const signupBody = {
    name: "Ada Lovelace",
    email: "ada@pdfdadi.example",
    password: "password123",
    confirmPassword: "password123",
  };

  function routeRequest(url: string, body: unknown, headers: Record<string, string>) {
    const request = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...headers },
      body: JSON.stringify(body),
    });
    // `getWorkspaceActor` reads `request.cookies`; emulate only that surface
    // rather than pulling in the Next server runtime.
    const cookie = headers.cookie;
    Object.defineProperty(request, "cookies", {
      value: { get: (name: string) => (cookie?.startsWith(`${name}=`) ? { name, value: cookie.slice(name.length + 1) } : undefined) },
      configurable: true,
    });
    return request as never;
  }

  it("signup succeeds with the public Origin and an internal request URL", async () => {
    // The exact request that answered 403 in the real standalone deployment.
    deployBehindProxy();
    const response = await signupPost(
      routeRequest("http://127.0.0.1:3000/api/auth/signup", signupBody, { origin: PUBLIC_ORIGIN }),
    );
    expect(response.status).toBe(201);
    expect(state.register).toHaveBeenCalledWith({
      email: signupBody.email,
      password: signupBody.password,
      name: signupBody.name,
    });
    expect(response.headers.get("set-cookie")).toContain(USER_SESSION_COOKIE);
  });

  it("signup from a foreign origin is still refused before any account is touched", async () => {
    deployBehindProxy();
    const response = await signupPost(
      routeRequest("http://127.0.0.1:3000/api/auth/signup", signupBody, { origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("CSRF_ORIGIN_REJECTED");
    expect(state.register).not.toHaveBeenCalled();
  });

  it("an authenticated workspace mutation succeeds with the public Origin", async () => {
    deployBehindProxy();
    const response = await workspacesPost(
      routeRequest(INTERNAL_URL, { organizationId: "org_1", name: "Launch" }, {
        origin: PUBLIC_ORIGIN,
        cookie: `${USER_SESSION_COOKIE}=session-token`,
      }),
    );
    expect(response.status).toBe(201);
    expect(state.createWorkspace).toHaveBeenCalled();
  });

  it("the same authenticated mutation from a foreign origin mutates nothing", async () => {
    deployBehindProxy();
    const response = await workspacesPost(
      routeRequest(INTERNAL_URL, { organizationId: "org_1", name: "Launch" }, {
        origin: "https://evil.example",
        cookie: `${USER_SESSION_COOKIE}=session-token`,
      }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("CSRF_ORIGIN_REJECTED");
    expect(state.createWorkspace).not.toHaveBeenCalled();
    // Refused before the session is even read — the check is first in the handler.
    expect(state.getMe).not.toHaveBeenCalled();
  });
});
