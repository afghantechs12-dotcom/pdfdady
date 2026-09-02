"use client";

import { useEffect, useState } from "react";

/**
 * The signed-in user as the PUBLIC site needs to know them: enough to switch
 * the header's calls to action, and nothing more.
 */
export interface PublicSessionUser {
  name: string | null;
  email: string;
}

export type PublicSessionState =
  | { status: "loading"; user: null }
  | { status: "signed-in"; user: PublicSessionUser }
  | { status: "signed-out"; user: null };

/**
 * Client-side session detection for the public marketing header.
 *
 * WHY THIS IS A CLIENT HOOK, not a server read of the session cookie:
 * reading cookies in a server component opts the whole route out of static
 * generation. Every public page (/, /tools, /pricing, /blog/*, the 18 tool
 * pages) is currently prerendered as static HTML or SSG, and turning ~30 routes
 * dynamic to personalise one button would cost the LCP and Lighthouse budgets
 * this milestone has to hit. The header ships as static signed-out markup and
 * upgrades itself after hydration instead.
 *
 * The cost is a brief interval where a signed-in visitor sees the signed-out
 * header. That is made non-disruptive by the header reserving a fixed-width
 * slot for the account area, so the swap changes content but never layout —
 * no cumulative layout shift.
 *
 * Security note: this is presentation only. It decides which links to draw,
 * never what a user may access. Every private route independently validates
 * the session server-side via `requireUser`, so a forged response here would
 * reveal nothing and grant nothing.
 */
export function usePublicSession(): PublicSessionState {
  const [state, setState] = useState<PublicSessionState>({
    status: "loading",
    user: null,
  });

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      try {
        const response = await fetch("/api/auth/me", {
          signal: controller.signal,
          // The session cookie is HttpOnly and same-origin; "same-origin"
          // credentials are the default for same-origin requests but are
          // declared for clarity.
          credentials: "same-origin",
          headers: { accept: "application/json" },
        });

        if (!response.ok) {
          // 401 is the normal signed-out case, not an error worth reporting.
          setState({ status: "signed-out", user: null });
          return;
        }

        const data: unknown = await response.json();
        const user =
          typeof data === "object" && data !== null && "user" in data
            ? (data as { user: { name?: string | null; email?: string } }).user
            : null;

        if (user && typeof user.email === "string") {
          setState({
            status: "signed-in",
            user: { name: user.name ?? null, email: user.email },
          });
        } else {
          setState({ status: "signed-out", user: null });
        }
      } catch {
        // An aborted request (unmount) or a network failure both mean "we do
        // not know" — presenting the signed-out header is the safe default,
        // because it never implies access the visitor may not have.
        if (!controller.signal.aborted) {
          setState({ status: "signed-out", user: null });
        }
      }
    }

    void load();
    return () => controller.abort();
  }, []);

  return state;
}
