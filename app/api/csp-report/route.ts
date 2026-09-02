import { NextResponse } from "next/server";
import { RateLimiter, clientIp } from "@/lib/server/rateLimit";
import { ConsoleLogger } from "@/src/infrastructure/logging/ConsoleLogger";
import {
  MAX_REPORTS_PER_REQUEST,
  parseCspReports,
  type SanitizedCspReport,
} from "@/lib/security/cspReport";
import { CSP_ENFORCED_HEADER, CSP_HEADER } from "@/lib/security/csp.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/csp-report` — the sink named by `report-uri` in every policy, and by the
 * `report-to` group on an https origin, both from `lib/security/csp.mjs`. One handler
 * for both: `parseCspReports` already reads the Reporting API's `application/reports+json`
 * batch as well as the legacy `application/csp-report` body.
 *
 * ## Diagnostics only
 *
 * This route reads no session, resolves nothing from the DI container, touches no
 * database, and has no path to the metering ledger or an entitlement. A browser
 * posting here can cause exactly one effect: a bounded log line. That is deliberate —
 * the endpoint is unauthenticated by necessity (a violation report has no session, and
 * a *blocked* page may not have booted far enough to have one), so it must be
 * incapable of the side effects an unauthenticated caller should not have.
 *
 * Deliberately NOT resolving `Tokens.Logger`: the container instantiates the whole
 * graph and validates env on first resolve. A misconfigured deployment would then turn
 * a violation report into a 500, which is the opposite of what this endpoint is for.
 * A local `ConsoleLogger` is the same structured JSON with none of that reach.
 *
 * ## It cannot break the app
 *
 * Nothing in the product calls this route, and report delivery is the browser's job on
 * its own schedule — a 4xx, a 5xx, or this handler being absent entirely all leave the
 * page unaffected, because CSP report delivery is fire-and-forget by specification and
 * report requests are themselves exempt from CSP. The failure mode of this file is
 * "we stop learning about violations", never "the app stops working". Every branch
 * below still answers rather than throwing, so a crafted body cannot even produce a
 * 500 to spam an error tracker with.
 */

/**
 * Whether this batch describes something the browser actually BLOCKED.
 *
 * Under an enforced policy a report is evidence of a break, not a heads-up, and the two
 * deserve different log levels — but the client is the wrong place to ask. Chrome sends
 * `disposition`; Firefox under the legacy format may not, and a real block that arrives
 * without the field would read as a harmless observation. So the shipped policy answers
 * for the missing case: every report we receive is about one of our own policies, and
 * {@link CSP_HEADER} says whether those enforce. An explicit `"report"` is still
 * believed, so a future report-only rollback does not shout.
 */
function wasBlocked(reports: readonly SanitizedCspReport[]): boolean {
  const enforcing = CSP_HEADER === CSP_ENFORCED_HEADER;
  return reports.some((r) =>
    r.disposition === undefined ? enforcing : r.disposition === "enforce",
  );
}

/**
 * ## Why nothing pages on this, deliberately
 *
 * A `warn` is as far as it goes, and that is the decision rather than an omission. This
 * endpoint is unauthenticated by necessity and its input is attacker-triggerable: any
 * page anywhere can provoke violations against our origin, and a POST here needs no
 * session. Wiring a pager to that gives anyone with `curl` a way to wake an on-call
 * engineer at will, repeatedly, at no cost to themselves — the rate limiter below caps
 * the log volume per IP, not the number of IPs. A break in the policy shows up in the
 * probe suite and in the enforced-level log lines, both of which an operator reads on
 * their own schedule; neither can be weaponized.
 *
 * The level split is what makes a log-based alert possible WITHOUT that exposure: an
 * operator who wants notification can key a threshold on `level=warn module=csp-report`
 * over a window and own the noise budget themselves. Building that here would mean this
 * repo choosing a channel, a credential, and a threshold on behalf of a deployment it
 * cannot see.
 */

/**
 * Per-IP budget.
 *
 * A single load of an over-restrictive page can legitimately fire a handful of
 * distinct violations, and Chrome batches them; 60/min leaves generous room for a
 * user clicking through the app while capping a `fetch` loop. Same single-instance
 * caveat as every other limiter here (see lib/server/rateLimit.ts) — behind N
 * instances the effective ceiling is N×60, which for a log sink is acceptable.
 */
const reportLimiter = new RateLimiter({ windowMs: 60_000, max: 60 });

/**
 * A violation report is a handful of short fields; a batch of
 * {@link MAX_REPORTS_PER_REQUEST} of them does not approach this.
 *
 * Enforced on the bytes actually read, not on `content-length`: that header is
 * client-supplied and a chunked POST may omit it, so trusting it alone leaves the cap
 * unenforced on precisely the requests that would abuse it. The header check is a
 * cheap early exit, nothing more.
 */
const MAX_BODY_BYTES = 16 * 1024;

const logger = new ConsoleLogger("info", { module: "csp-report" });

export async function POST(request: Request) {
  if (reportLimiter.hit(clientIp(request))) {
    return NextResponse.json(
      { error: "Too many requests." },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  const raw = await request.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  // Malformed, empty, wrong shape, or a batch of report types we do not handle: all
  // 204. There is no useful distinction to draw for the caller, and drawing one turns
  // the endpoint into an oracle for what the parser accepts.
  const reports = parseCspReports(raw);
  if (reports.length > 0) {
    // One line per request, not per report — a page with many violations must not be
    // able to multiply itself through the log.
    const fields = { count: reports.length, reports };
    if (wasBlocked(reports)) logger.warn("csp violation blocked", fields);
    else logger.info("csp violation", fields);
  }

  return noContent();
}

/**
 * Everything that is not a POST.
 *
 * 405 rather than a silent 204: a GET here is a person or a scanner, not a browser
 * delivering a report, and telling them the method is wrong costs nothing. `Allow`
 * is required on a 405 by RFC 9110.
 */
function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { error: "Method not allowed." },
    { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } },
  );
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

/** 204, `no-store`, empty body — a report sink has nothing to say back. */
function noContent(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
