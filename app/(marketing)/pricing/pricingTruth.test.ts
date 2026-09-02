import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * U23 — Pricing consumes canonical plan truth.
 *
 * `data/pricing.test.ts` already proves the plan DATA is honest. This file
 * proves the page reads it: the plans below are synthetic, so any string the
 * page renders from its own source instead of from `getPricingList()` shows up
 * as a missing synthetic value or a leaked real one.
 *
 * That is the whole point. A hardcoded "$0 / today" card looks identical to a
 * correct one in a screenshot and in a source scan of the page — it only
 * separates under a store that says something different.
 *
 * Async server component, so it is invoked directly and its returned tree is
 * rendered. The three Pro client components resolve to their fallbacks here
 * (their fetch lives in an effect, which SSR does not run), which is the
 * documented no-Stripe rendering and therefore the right thing to assert.
 */

const PLANS = [
  {
    id: "free",
    name: "Starter tier",
    price: "$0",
    period: "today",
    description: "Synthetic free description.",
    features: ["Synthetic free feature"],
    cta: "Synthetic free CTA",
    href: "/synthetic-free",
    available: true,
  },
  {
    id: "pro",
    name: "Middle tier",
    price: "Not yet available",
    description: "Synthetic pro description.",
    features: ["Synthetic pro feature"],
    cta: "Synthetic pro CTA",
    href: "/contact",
    available: false,
    highlighted: true,
  },
  {
    id: "business",
    name: "Top tier",
    price: "Talk to us",
    description: "Synthetic business description.",
    features: ["Synthetic business feature"],
    cta: "Synthetic business CTA",
    href: "/contact",
    available: false,
  },
];

const runtime = vi.hoisted(() => ({
  getPricingList: vi.fn(),
  getPage: vi.fn(),
  getFaqItems: vi.fn(),
}));

vi.mock("@/lib/seo/adminRuntime", () => runtime);

const render = async () => {
  const { default: PricingPage } = await import("./page");
  return renderToStaticMarkup(await PricingPage());
};

beforeEach(() => {
  runtime.getPricingList.mockResolvedValue(PLANS);
  runtime.getPage.mockResolvedValue({
    title: "Synthetic heading",
    description: "Synthetic intro copy.",
  });
  runtime.getFaqItems.mockResolvedValue([
    { id: "free", question: "Synthetic question?", answer: "Synthetic answer." },
    { id: "unrelated", question: "Not billing?", answer: "Should not appear." },
  ]);
});

describe("U23 — Pricing consumes canonical plan truth", () => {
  it("renders every plan from the store, and nothing from a second source", async () => {
    const html = await render();
    for (const plan of PLANS) {
      expect(html).toContain(plan.name);
      expect(html).toContain(plan.description);
      expect(html).toContain(plan.features[0]);
      expect(html).toContain(plan.cta);
      expect(html).toContain(`href="${plan.href}"`);
    }
    // The real plan names. Present means the page kept a copy of its own.
    expect(html).not.toMatch(/>Free</);
    expect(html).not.toContain("Every tool that works today, plus a Workspace");
  });

  it("takes its heading from the page store rather than the built-in fallback", async () => {
    expect(await render()).toContain("Synthetic heading");
    runtime.getPage.mockResolvedValue(null);
    // The fallback is allowed to exist — it is what an unconfigured store gets —
    // but only when the store returned nothing.
    expect(await render()).toContain("Free to start");
  });

  it("badges availability from the plan, not from the plan's position", async () => {
    const html = await render();
    // One available plan in this store, two not. A page with hardcoded badges
    // would show whatever the real store's split is instead.
    expect(html.match(/Available now/g) ?? []).toHaveLength(1);
    expect(html.match(/Coming later/g) ?? []).toHaveLength(2);
  });

  it("counts availability instead of asserting a number", async () => {
    expect(await render()).toContain("One plan is available today");
    runtime.getPricingList.mockResolvedValue(PLANS.map((p) => ({ ...p, available: true })));
    const all = await render();
    expect(all).toContain("3 plans are available today");
    expect(all).not.toContain("not built yet");
  });

  it("offers no purchase control for a plan the store says is unavailable", async () => {
    const html = await render();
    // Unavailable plans get an outline link to somewhere real — never a
    // disabled button, which reads as "checkout is one release away".
    // The attribute, not the `disabled:` Tailwind variant every button carries.
    expect(html).not.toMatch(/<(?:button|a)\b[^>]*\sdisabled[\s=>]/);
    // Every CTA is a real link to somewhere, including the two unavailable ones.
    for (const plan of PLANS) {
      expect(html).toMatch(new RegExp(`<a\\b[^>]*href="${plan.href}"[^>]*>${plan.cta}</a>`));
    }
  });

  it("shows only the billing-relevant shared FAQ entries", async () => {
    const html = await render();
    expect(html).toContain("Synthetic question?");
    expect(html).not.toContain("Should not appear.");
  });

  it("never renders a billing period the store did not give", async () => {
    const html = await render();
    // `/today` for Free, and no invented `/month` for the other two.
    expect(html).toContain("/today");
    expect(html).not.toMatch(/\/month|\/year|save \d+%/i);
  });
});
