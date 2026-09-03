import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pricingPlans } from "@/data/pricing";
import { publicPlanAvailability } from "@/src/domain/billing/proOffer";
import { PURCHASABLE_PLAN_IDS } from "@/src/domain/billing/subscription";

/**
 * Pricing copy honesty (launch polish P1-13).
 *
 * The launch hero pill says "Free to start", but the free plan card said
 * "$0 / forever". "Forever" is a pricing commitment the product has not made —
 * whether the free tier stays free once paid plans exist is a business
 * decision, not a fact. These assertions keep the single pricing source honest
 * without hardcoding UI strings.
 */

describe("pricing data stays truthful about the free tier", () => {
  it("does not claim the free plan is free forever", () => {
    const free = pricingPlans.find((p) => p.id === "free");
    expect(free, "free plan must exist").toBeDefined();
    expect(free!.period?.toLowerCase()).not.toBe("forever");
  });

  it("describes the free tier as free today, which is verifiably true", () => {
    const free = pricingPlans.find((p) => p.id === "free");
    expect(free!.period?.toLowerCase()).toBe("today");
    expect(free!.price).toBe("$0");
  });

  it("unavailable plans do not masquerade as purchasable", () => {
    for (const plan of pricingPlans.filter((p) => !p.available)) {
      expect(plan.price, plan.name).not.toMatch(/^\$/);
      expect(plan.price, plan.name).not.toMatch(/month|year/i);
      expect(plan.href, plan.name).toBe("/contact");
    }
  });
});

/**
 * T9/T10 — what the public surfaces may say about billing and about teams.
 *
 * The recorded contradiction: /pricing said "there is no checkout on this site
 * yet" and "no payment details are collected anywhere on this site" while the
 * repository contains Stripe-backed Pro checkout, a webhook handler, a billing
 * portal and an upgrade control. Both cannot be true, and which one is depends on
 * the deployment — so no static string may assert either.
 */
describe("T9 — billing claims are per-deployment, never asserted statically", () => {
  it("resolves a plan's public state from the domain, not from a stored boolean", () => {
    expect(publicPlanAvailability("free", false)).toBe("free");
    // The same plan, two deployments. A static "not yet available" is wrong in one.
    expect(publicPlanAvailability("pro", true)).toBe("purchasable");
    expect(publicPlanAvailability("pro", false)).toBe("configured-elsewhere");
  });

  it("keeps Business unsellable even in a fully configured deployment", () => {
    // Enforced by the absence of a `business` slot in BillingPriceMap, not by copy.
    expect(publicPlanAvailability("business", true)).toBe("deferred");
    expect(PURCHASABLE_PLAN_IDS).not.toContain("business");
  });

  it("states no absolute absence of checkout on any public surface", () => {
    // Each phrase was on screen and is false in a deployment with Stripe
    // configured. Comments are stripped first: Hero and pricing.ts both record
    // in prose why the wording was dropped, and that record is the point.
    for (const file of [
      "app/(marketing)/pricing/page.tsx",
      "components/home/PricingPreview.tsx",
      "components/home/Hero.tsx",
      "data/pricing.ts",
    ]) {
      const src = readFileSync(path.join(process.cwd(), file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");
      for (const phrase of [
        "no checkout on this site",
        "Nothing on this site can be bought",
        "there is no checkout and no",
        "Free while we build",
      ]) {
        expect(src, `${file} asserts "${phrase}"`).not.toContain(phrase);
      }
    }
  });

  it("keeps the one remaining absence sentence inside the unconfigured branch", () => {
    // "no payment details are collected anywhere on this site" is true in both
    // deployments — card details are entered on Stripe's hosted page — but the
    // sentence it sits in counts unavailable plans, so it belongs in the
    // fallback. Asserting it is inside `fallback={` is what stops it from being
    // promoted to unconditional copy.
    const page = readFileSync(
      path.join(process.cwd(), "app/(marketing)/pricing/page.tsx"),
      "utf8",
    );
    const sentence = "no payment details are collected anywhere on this site";
    const at = page.indexOf(sentence);
    expect(at).toBeGreaterThan(-1);
    const before = page.slice(0, at);
    expect(before.lastIndexOf("fallback={")).toBeGreaterThan(before.lastIndexOf("</ProConfigured>"));
  });

  it("shows no purchase control at all when the summary says unavailable", () => {
    // The whole per-deployment scheme rests on one line: every control-rendering
    // path in ProUpgradeAction sits *after* an early return of `children` for a
    // missing summary or an `unavailable` action. Delete that line and an
    // unconfigured deployment renders a checkout button, which is exactly the
    // failure the copy above was rewritten to allow. Asserted on source because
    // vitest runs without a DOM and cannot render the component.
    const action = readFileSync(
      path.join(process.cwd(), "components/billing/ProUpgradeAction.tsx"),
      "utf8",
    );
    const guard = /if \(!summary \|\| summary\.action === "unavailable"\) return <>\{children\}<\/>;/;
    expect(action).toMatch(guard);
    // Nothing that renders a control may precede it.
    const before = action.slice(0, action.search(guard));
    expect(before).not.toContain("<Button");
    expect(before).not.toContain("<Control");
    // ProConfigured and ProPriceLabel carry the same shape of fallback.
    expect(action).toContain("summary?.configured ? children : fallback");
    expect(action).toMatch(/if \(!summary\?\.priceLabel\) return <>\{children\}<\/>;/);
  });

  it("gates the live billing copy on the deployment's own configuration", () => {
    const page = readFileSync(
      path.join(process.cwd(), "app/(marketing)/pricing/page.tsx"),
      "utf8",
    );
    // ProConfigured resolves /api/billing/summary and falls back to the approved
    // server-rendered copy, so a deployment that cannot take money says so.
    expect(page).toContain("ProConfigured");
    expect(page).toContain("ProUpgradeAction");
  });
});

describe("T10 — team features are advertised on the plan that has them", () => {
  it("lists shared Workspaces and roles on Free, where they work today", () => {
    const free = pricingPlans.find((p) => p.id === "free");
    const bullets = free!.features.join(" ").toLowerCase();
    expect(bullets).toContain("shared workspace");
    expect(bullets).toMatch(/viewer|role/);
  });

  it("does not sell Business the features Free already includes", () => {
    const business = pricingPlans.find((p) => p.id === "business");
    const bullets = [business!.description, ...business!.features].join(" ").toLowerCase();
    // What Business is actually waiting on is billing, not collaboration.
    expect(bullets).not.toMatch(/shared (team )?workspaces? (for|with)/);
    expect(bullets).not.toMatch(/per-member roles/);
    expect(bullets).toMatch(/invoice|billing/);
  });

  it("does not call adding an existing member an invitation", () => {
    // There is no invitation token, no pending state and no email delivery: the
    // action adds an account that already exists. Business may promise invitation
    // emails because Business is explicitly not built.
    const members = readFileSync(
      path.join(process.cwd(), "components/workspaces/WorkspaceMembers.tsx"),
      "utf8",
    );
    expect(members).not.toMatch(/>\s*Invite/);
    expect(members).not.toContain("Invitation sent");
  });
});

/**
 * R26 — the enquiry path Pricing sends people down has to be honest too.
 *
 * `unavailable plans do not masquerade as purchasable` (above) asserts every plan
 * without checkout points at `/contact`. That makes the contact form part of the
 * commercial surface: it is where someone who wants Business is told to go. The
 * form has no backend — it validates, then renders an acknowledgement — and the
 * acknowledgement used to read "we've noted your message" under a green tick,
 * which is not true of a submit handler whose only effect is `setSubmitted(true)`.
 *
 * The assertion is conditional on purpose: the day a real transport lands, the
 * delivery claim becomes true and this test must not stand in its way. What it
 * refuses is the combination — no transport AND a claim of delivery.
 */
describe("R26 — /contact does not acknowledge messages it cannot deliver", () => {
  /*
   * Comments are stripped and whitespace is collapsed before matching, and both
   * steps were forced by watching this test fail to do its job. Version one matched
   * the comment inside the component that QUOTES the old claim — a gate a comment
   * can flip is reading the wrong text. Version two then passed with the old copy
   * restored, because JSX wrapped it as "noted your\n message" and the pattern
   * never crossed the newline: a source scan that is not whitespace-insensitive
   * proves whatever the formatter felt like doing.
   */
  const form = readFileSync(
    path.join(process.cwd(), "components/contact/ContactForm.tsx"),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join(" ")
    .replace(/\s+/g, " ");
  const hasTransport = /fetch\(|useFormState|"use server"|action=\{/.test(form);

  it("claims nothing about delivery while nothing is delivered", () => {
    if (hasTransport) return; // a backend exists; the claims below are then checkable behaviour
    expect(form, "an unconnected form must not say the message was received")
      .not.toMatch(/noted your message|we(?:'|&apos;)ve (?:got|received)|message (?:sent|received)/i);
    expect(form, "and it must say so, rather than only omitting the claim")
      .toMatch(/isn(?:'|&apos;)t connected|nothing was sent/i);
  });

  it("offers a real channel instead of a dead form", () => {
    expect(form).toMatch(/href="mailto:[^"]+@[^"]+"/);
  });

  it("still validates before it tells anyone to retype the address elsewhere", () => {
    expect(form).toContain("contactSchema.safeParse");
  });
});
