import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Tests for the page-level session guards.
 *
 * The focus is the REDIRECT TARGET. The reported 405 was caused by
 * `redirect("/api/auth/login")`: a Next redirect is a top-level GET navigation,
 * and that route exports only POST. These tests pin the contract that page
 * guards send users to the /login PAGE and never to an API route.
 */

const state = vi.hoisted(() => ({
  cookieValue: undefined as string | undefined,
  getMe: vi.fn(),
}));

class RedirectSignal extends Error {
  constructor(readonly location: string) {
    super(`NEXT_REDIRECT:${location}`);
  }
}

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      state.cookieValue !== undefined && name === "pdfdadi_session"
        ? { name, value: state.cookieValue }
        : undefined,
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (location: string) => {
    throw new RedirectSignal(location);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("@/src/application/di/container", () => ({
  appContainer: {
    resolve: (token: symbol) => {
      if (token.description === "AuthService") return { getMe: state.getMe };
      throw new Error(`unexpected token ${String(token.description)}`);
    },
  },
}));

import {
  currentUser,
  loginRedirectUrl,
  redirectIfAuthenticated,
  requireUser,
} from "./authSession";

const user = {
  id: "user_1",
  email: "ada@example.com",
  name: "Ada Lovelace",
  provider: "local" as const,
  providerExternalId: null,
  passwordHash: "salt:hash",
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** Captures the location a guard redirected to, or null if it did not. */
async function captureRedirect(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    if (error instanceof RedirectSignal) return error.location;
    throw error;
  }
}

beforeEach(() => {
  state.cookieValue = undefined;
  state.getMe.mockReset();
  state.getMe.mockResolvedValue(user);
});

describe("loginRedirectUrl", () => {
  it("targets the /login PAGE, never the POST-only API route", () => {
    const url = loginRedirectUrl("/workspaces");
    // This is the regression guard for the original 405.
    expect(url.startsWith("/login?")).toBe(true);
    expect(url).not.toContain("/api/auth");
  });

  it("round-trips a safe internal destination", () => {
    expect(loginRedirectUrl("/workspaces")).toBe("/login?next=%2Fworkspaces");
    expect(loginRedirectUrl("/workspaces/abc?tab=files")).toBe(
      "/login?next=%2Fworkspaces%2Fabc%3Ftab%3Dfiles",
    );
  });

  it("replaces a hostile destination with the default", () => {
    for (const hostile of ["https://evil.test", "//evil.test", "javascript:alert(1)"]) {
      expect(loginRedirectUrl(hostile)).toBe("/login?next=%2Fworkspaces");
    }
  });
});

describe("currentUser", () => {
  it("returns null when no session cookie is present", async () => {
    expect(await currentUser()).toBeNull();
    // No cookie means no lookup is even attempted.
    expect(state.getMe).not.toHaveBeenCalled();
  });

  it("validates the token against the session store rather than trusting the cookie", async () => {
    state.cookieValue = "token-abc";
    expect(await currentUser()).toEqual(user);
    expect(state.getMe).toHaveBeenCalledWith("token-abc");
  });

  it("returns null when the token does not resolve to a live session", async () => {
    state.cookieValue = "expired-token";
    state.getMe.mockResolvedValue(null);
    expect(await currentUser()).toBeNull();
  });
});

describe("requireUser", () => {
  it("redirects an unauthenticated visitor to /login carrying next", async () => {
    const location = await captureRedirect(() => requireUser("/workspaces"));
    expect(location).toBe("/login?next=%2Fworkspaces");
  });

  it("redirects when the session cookie is present but stale", async () => {
    state.cookieValue = "expired-token";
    state.getMe.mockResolvedValue(null);
    const location = await captureRedirect(() => requireUser("/workspaces"));
    expect(location).toBe("/login?next=%2Fworkspaces");
  });

  it("returns the user without redirecting when authenticated", async () => {
    state.cookieValue = "token-abc";
    expect(await requireUser("/workspaces")).toEqual(user);
  });

  it("never redirects to an API route for any intended path", async () => {
    for (const intended of ["/workspaces", "/editor", "/workspaces/x?y=z", "https://evil.test"]) {
      const location = await captureRedirect(() => requireUser(intended));
      expect(location).not.toBeNull();
      expect(location).not.toContain("/api/");
      expect(location!.startsWith("/login?")).toBe(true);
    }
  });
});

describe("redirectIfAuthenticated", () => {
  it("does nothing for an anonymous visitor, so /login renders", async () => {
    expect(await captureRedirect(() => redirectIfAuthenticated("/workspaces"))).toBeNull();
  });

  it("sends an authenticated visitor to their workspaces", async () => {
    state.cookieValue = "token-abc";
    expect(await captureRedirect(() => redirectIfAuthenticated(null))).toBe("/workspaces");
  });

  it("honours a safe next destination", async () => {
    state.cookieValue = "token-abc";
    expect(await captureRedirect(() => redirectIfAuthenticated("/workspaces/abc"))).toBe(
      "/workspaces/abc",
    );
  });

  it("ignores a hostile next destination", async () => {
    state.cookieValue = "token-abc";
    for (const hostile of ["https://evil.test", "//evil.test", "/\\evil.test"]) {
      expect(await captureRedirect(() => redirectIfAuthenticated(hostile))).toBe("/workspaces");
    }
  });

  it("cannot produce a redirect loop back to an auth page", async () => {
    state.cookieValue = "token-abc";
    // /login?next=/login would otherwise bounce an authenticated user to
    // /login forever. Auth pages are rejected as destinations.
    for (const authPath of ["/login", "/signup", "/register", "/login?next=%2Flogin", "/api/auth/login"]) {
      expect(await captureRedirect(() => redirectIfAuthenticated(authPath))).toBe("/workspaces");
    }
  });
});
