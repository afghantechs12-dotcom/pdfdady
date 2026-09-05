import { describe, expect, it, vi } from "vitest";
import { persistPricingPlans } from "./pricingPersistence";
import type { PricingPlan } from "@/data/pricing";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SaveButton, SaveStatus } from "./SaveStatus";
const plan = (id: string): PricingPlan => ({ id, name: id, price: "$0", features: [], cta: "Get started", href: "/tools", available: true, highlighted: false, description: "" });
describe("pricing save feedback", () => {
  it("marks only successful snapshots saved when a batch fails", async () => {
    const save = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false });
    const onSaved = vi.fn();
    await expect(persistPricingPlans([plan("one"), plan("two"), plan("three")], { save, onSaved })).rejects.toThrow('Could not save two');
    expect(save).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledExactlyOnceWith("one", JSON.stringify(plan("one")));
  });
  it("uses captured values while requests await and retains edits on network failure", async () => {
    const input = [plan("one"), plan("two")];
    const onSaved = vi.fn();
    const save = vi.fn(async (id: string, snapshot: string) => {
      input[1].price = "$10";
      if (id === "two") expect(JSON.parse(snapshot).price).toBe("$0");
      return { ok: true };
    });
    await persistPricingPlans(input, { save, onSaved });
    expect(onSaved).toHaveBeenCalledTimes(2);
    await expect(persistPricingPlans(input, { save: async () => { throw new Error("offline"); }, onSaved })).rejects.toThrow("offline");
    expect(input[1].price).toBe("$10");
  });
  it("saving status disables submission and saved status is announced", () => {
    expect(renderToStaticMarkup(createElement(SaveButton, { status: "saving", busy: false }))).toContain('disabled=""');
    expect(renderToStaticMarkup(createElement(SaveStatus, { status: "saved" }))).toContain('role="status"');
  });
});
