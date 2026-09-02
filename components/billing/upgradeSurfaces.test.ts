import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pricingPlans } from "@/data/pricing";
import { PURCHASABLE_PLAN_IDS } from "@/src/domain/billing/subscription";
import { allowedPropertiesFor, isClientIngestibleEvent } from "@/src/domain/metering/events";

/**
 * The parts of the upgrade UX that only exist in `.tsx`.
 *
 * Vitest runs `environment: "node"`, so these components cannot be rendered here —
 * and the properties below are not about rendering anyway. They are about what the
 * files are allowed to *contain*: a price nobody approved, a second place that
 * knows a billing endpoint, an optimistic entitlement written on the way back from
 * Stripe, a live purchase control on the plan that cannot be purchased. Each one
 * is a mistake a reviewer would have to notice by eye otherwise, and each is a
 * one-line edit away at any time.
 *
 * Where a check needs the real data (is there still a non-purchasable plan to
 * protect? is `upgrade_view` still in the vocabulary?) it imports the real module
 * rather than a fixture, so the check cannot pass by having nothing to look at.
 */

const HERE = __dirname;
const read = (p: string) => readFileSync(p, "utf8");

const SOURCES = {
  action: read(join(HERE, "ProUpgradeAction.tsx")),
  client: read(join(HERE, "proSummaryClient.ts")),
  pricing: read(join(HERE, "..", "..", "app", "(marketing)", "pricing", "page.tsx")),
  usage: read(join(HERE, "..", "app", "UsageCard.tsx")),
  dashboard: read(join(HERE, "..", "workspaces", "WorkspaceDashboard.tsx")),
};

/** Prose is where the endpoints and the reasoning are *supposed* to be named. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const SURFACES: Array<[string, string]> = [
  ["ProUpgradeAction.tsx", code(SOURCES.action)],
  ["pricing/page.tsx", code(SOURCES.pricing)],
  ["UsageCard.tsx", code(SOURCES.usage)],
];

// ===========================================================================
// 1. No number the deployment did not configure
// ===========================================================================

describe("no fabricated money", () => {
  it("writes no currency amount into any upgrade surface", () => {
    for (const [name, src] of SURFACES) {
      expect(src, name).not.toMatch(/[$€£¥₹]\s*\d/);
      expect(src, name).not.toMatch(/\b\d+(?:[.,]\d+)?\s*(?:usd|eur|gbp|dollars?)\b/i);
      expect(src, name).not.toMatch(/\bper\s+month\b/i);
    }
  });

  it("renders no digit at all in the price label component", () => {
    // The label's only two outputs are the amount read from the provider and the
    // approved copy passed as children. A literal digit appearing in this function
    // is, by construction, a number nobody approved.
    const body = SOURCES.action.slice(SOURCES.action.indexOf("export function ProPriceLabel"));
    expect(body).toContain("children");
    expect(code(body)).not.toMatch(/\d/);
  });

  it("keeps the approved server copy as the pricing card's fallback", () => {
    const tag = SOURCES.pricing.match(/<ProUpgradeAction[\s\S]*?<\/ProUpgradeAction>/);
    expect(tag).not.toBeNull();
    // Children, not a self-closing tag: an unconfigured deployment and a failed
    // summary request both fall back to the store's own CTA.
    expect(tag![0]).toContain("plan.cta");
  });
});

// ===========================================================================
// 2. One place knows how to talk to billing
// ===========================================================================

describe("billing requests", () => {
  it("never calls fetch or names a billing endpoint outside the shared client", () => {
    for (const [name, src] of SURFACES) {
      // UsageCard has its own `/api/usage` fetch, which predates billing; what no
      // surface may have is a request to a billing endpoint.
      expect(src, name).not.toMatch(/\/api\/billing/);
    }
    expect(code(SOURCES.action)).not.toMatch(/\bfetch\s*\(/);
    expect(code(SOURCES.pricing)).not.toMatch(/\bfetch\s*\(/);
    expect(code(SOURCES.client)).toMatch(/\/api\/billing\/checkout/);
  });

  it("navigates only to a URL the server returned", () => {
    const navigations = [...code(SOURCES.action).matchAll(/location\.(?:assign|replace|href\s*=)\s*\(?\s*([^;)\n]*)/g)];
    expect(navigations).toHaveLength(1);
    expect(navigations[0][1]).toContain("result.url");
    // No Stripe URL is ever built here: checkout.stripe.com appears nowhere.
    expect(code(SOURCES.action)).not.toMatch(/stripe\.com/i);
  });
});

// ===========================================================================
// 3. Coming back from checkout grants nothing
// ===========================================================================

describe("returning from checkout", () => {
  it("only ever holds a summary the server produced", () => {
    const writes = [...code(SOURCES.action).matchAll(/setSummary\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(writes.length).toBeGreaterThan(0);
    // `current` is the value of a load/refresh call. An object literal here would be
    // an entitlement this component decided, which is the webhook's job.
    expect([...new Set(writes)]).toEqual(["current"]);
  });

  it("re-reads the server rather than trusting the success parameter", () => {
    const src = code(SOURCES.action);
    expect(src).toContain("refreshProSummary");
    expect(src).toContain("awaitingEntitlement");
    // Names no plan of its own — `fromPlan` comes off the summary.
    expect(src).not.toMatch(/["']pro["']/);
    expect(src).not.toMatch(/\bplan\s*[:=]/);
  });

  it("bounds the activation wait", () => {
    const src = code(SOURCES.action);
    expect(src).not.toMatch(/\bwhile\s*\(/);
    const tries = src.match(/ACTIVATION_TRIES\s*=\s*(\d+)/);
    expect(tries).not.toBeNull();
    expect(Number(tries![1])).toBeLessThanOrEqual(10);
    expect(src).toContain("i < ACTIVATION_TRIES");
  });
});

// ===========================================================================
// 4. Business is still not for sale
// ===========================================================================

describe("non-purchasable plans", () => {
  it("has a non-purchasable plan to protect in the first place", () => {
    // Without this the guard test below would pass on a page with nothing to guard.
    const unsellable = pricingPlans.filter((p) => !PURCHASABLE_PLAN_IDS.includes(p.id as never));
    expect(unsellable.length).toBeGreaterThan(0);
    expect(unsellable.some((p) => p.id === "business")).toBe(true);
    for (const plan of unsellable) expect(plan.href).not.toMatch(/^\/api\//);
  });

  it("keeps every live control inside the Pro branch of the plan loop", () => {
    const src = SOURCES.pricing;
    const start = src.indexOf("plans.map(");
    expect(start).toBeGreaterThan(-1);
    // The map's real extent, by paren matching. Its first `))}` belongs to the
    // nested `plan.features.map(...)` — a region cut there would scan the badge and
    // the price and miss the button, which is the control that spends money.
    let depth = 0;
    let end = start;
    for (; end < src.length; end++) {
      if (src[end] === "(") depth++;
      else if (src[end] === ")" && --depth === 0) break;
    }
    const loop = src.slice(start, end);
    expect(loop, "the scanned region must reach the card's CTA").toContain("plan.cta");
    const controls = [...loop.matchAll(/<Pro(?:UpgradeAction|Configured|PriceLabel)\b/g)];
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      const before = loop.slice(0, control.index);
      const guard = before.lastIndexOf('plan.id === "pro"');
      expect(guard, "a live Pro control outside the Pro branch").toBeGreaterThan(-1);
      // The nearest thing above it is the guard, not the ternary's else arm — which
      // is where a control would sit if it had drifted onto every plan's card.
      expect(before.lastIndexOf(") : (")).toBeLessThan(guard);
    }
  });
});

// ===========================================================================
// 5. Wiring the two surfaces
// ===========================================================================

describe("surface wiring", () => {
  it("declares an analytics surface on every control", () => {
    const tags = [...SOURCES.pricing.matchAll(/<ProUpgradeAction[\s\S]*?>/g), ...SOURCES.usage.matchAll(/<ProUpgradeAction[\s\S]*?>/g)];
    expect(tags.length).toBe(2);
    for (const tag of tags) expect(tag[0]).toMatch(/surface="[a-z_]+"/);
  });

  it("emits only an event the real vocabulary ingests, with a declared property", () => {
    const emitted = [...code(SOURCES.action).matchAll(/track\w*\([^,]*,\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(emitted).toEqual(["upgrade_view"]);
    // Filtering through the real type guard both narrows for `allowedPropertiesFor`
    // and *is* the assertion: any emitted name outside the ingestible set drops out
    // of `ingestible` and fails the equality below.
    const ingestible = emitted.filter(isClientIngestibleEvent);
    expect(ingestible).toEqual(emitted);
    for (const name of ingestible) {
      expect([...allowedPropertiesFor(name)]).toContain("fromPlan");
    }
  });

  it("takes the workspace organization from the server-rendered dashboard, not the browser", () => {
    expect(code(SOURCES.usage)).toContain("organizationId={organizationId}");
    expect(code(SOURCES.usage)).not.toMatch(/useSearchParams|URLSearchParams|localStorage/);
    expect(code(SOURCES.dashboard)).toMatch(/<UsageCard\s+organizationId={organizationId}/);
  });
});

// ===========================================================================
// 6. A billing failure stays inside the billing card
// ===========================================================================

describe("failure isolation", () => {
  it("guards every summary read, with no non-null assertion anywhere", () => {
    const src = code(SOURCES.action);
    // The early return that makes every later `summary.x` safe. Without it the
    // failure path (summary === null) is a null dereference during render, and a
    // render throw takes down the whole subtree it sits in — the usage card, and
    // with it the workspace dashboard.
    const guard = src.indexOf("if (!summary ||");
    expect(guard, "the null-summary early return is gone").toBeGreaterThan(-1);
    const before = src.slice(0, guard);
    const reads = [...before.matchAll(/summary(\??)\.(\w+)/g)];
    expect(reads.length, "nothing reads the summary before the guard at all").toBeGreaterThan(0);
    for (const read of reads) {
      const optional = read[1] === "?";
      const window = before.slice(Math.max(0, read.index - 120), read.index);
      const checked = /if \(summary\)|summary &&/.test(window);
      expect(optional || checked, `unguarded summary.${read[2]} above the null check`).toBe(true);
    }
    expect(src, "a non-null assertion turns the failure path back into a crash").not.toMatch(
      /summary!/,
    );
  });

  it("raises nothing out of the billing surfaces", () => {
    // Both halves absorb their own failures and return a fallback value. A
    // `throw` here would surface as an unhandled rejection in the effect, or as a
    // render error in whatever card embedded the control.
    expect(code(SOURCES.action)).not.toMatch(/\bthrow\b/);
    expect(code(SOURCES.client)).not.toMatch(/\bthrow\b/);
  });

  it("keeps the usage card's own content independent of the billing summary", () => {
    const usage = code(SOURCES.usage);
    // The card never reads billing state itself, so there is no branch on which
    // its meters, limits or file-size line could be withheld because a billing
    // request failed. The control is a leaf that renders nothing on its own.
    expect(usage).not.toMatch(/loadProSummary|refreshProSummary|ProSummaryView|awaitingEntitlement/);
    expect(usage).toMatch(/<ProUpgradeAction/);
    // No children: an in-app surface has no approved fallback copy, so a failed
    // summary must leave the card exactly as it was rather than render a guess.
    expect(usage).not.toMatch(/<ProUpgradeAction[\s\S]*?>[\s\S]*?<\/ProUpgradeAction>/);
  });

  it("fires analytics without a value the control depends on", () => {
    const src = code(SOURCES.action);
    // `trackOnce` is called for its effect and its result is never read, so an
    // analytics failure cannot decide whether a button renders. The hook itself
    // swallows send failures; this pins that nothing here starts depending on one.
    expect(src).toMatch(/\n\s*if \(summary\) trackOnce\(/);
    expect(src).not.toMatch(/await trackOnce|= trackOnce\(|trackOnce\([\s\S]{0,200}?\)\s*\./);
  });
});

// ===========================================================================
// 7. No client state is the plan authority
// ===========================================================================

describe("client state grants nothing", () => {
  it("reads no browser-persisted state anywhere in the upgrade path", () => {
    for (const [name, src] of [...SURFACES, ["proSummaryClient.ts", code(SOURCES.client)]]) {
      expect(src, name).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    }
  });

  it("never decides a plan in the browser half", () => {
    const client = code(SOURCES.client);
    // Exactly one `"pro"`: the plan being *requested* in the checkout POST body.
    // A second one would be a plan the browser concluded rather than read.
    const literals = [...client.matchAll(/"pro"/g)];
    expect(literals.length).toBe(1);
    expect(client.slice(Math.max(0, literals[0].index - 40), literals[0].index)).toContain("plan:");
    // And nothing maps a URL, a query parameter or a redirect onto plan state.
    expect(client).not.toMatch(/window\.|location|URLSearchParams|searchParams/);
  });

  it("uses the checkout query only to decide whether to re-read the server", () => {
    const src = code(SOURCES.action);
    expect([...src.matchAll(/get\("checkout"\)/g)].length).toBe(1);
    // Exactly "success", not merely "present" or "not cancelled": the cancel URL
    // sends the visitor back to `?checkout=cancelled`, and a looser comparison
    // would start the activation wait for someone who abandoned the purchase.
    expect(src).toMatch(/get\("checkout"\) === "success"/);
    // The query's only consumer is a short-circuit: it decides whether to poll,
    // and produces no value that reaches summary state. Combined with
    // `setSummary` only ever holding `current`, `?checkout=success` cannot become
    // an entitlement, a label or an action.
    expect(src).toContain("if (!returnedFromCheckout()) return;");
  });

  it("exposes no endpoint that could confirm or activate a checkout", () => {
    const dir = join(HERE, "..", "..", "app", "api", "billing");
    const routes = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    // Enumerated rather than pattern-matched, so a new `confirm/`, `activate/` or
    // `sync/` route fails here on the day it is added — including one added with
    // the best of intentions to "finish" a checkout the webhook has not confirmed.
    expect(routes).toEqual(["checkout", "portal", "summary", "webhook"]);
  });
});
