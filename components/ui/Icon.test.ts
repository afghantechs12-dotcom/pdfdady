import { describe, expect, it } from "vitest";
import { ICON_NAMES, isKnownIconName } from "./Icon";
import { tools } from "@/data/tools";
import { features } from "@/data/features";
import { useCases } from "@/data/useCases";
import { trustItems } from "@/data/trust";
import { aiTools } from "@/data/aiTools";
import { workflowSteps } from "@/data/howItWorks";
import { productHighlights } from "@/data/productHighlights";

/**
 * `Icon` resolves a data-supplied string against a curated map, falling back to
 * a blank square when the name is unknown. That fallback is deliberate — the
 * admin console lets someone type any icon name — but it means a typo in a
 * committed data file renders an empty box with no error anywhere.
 *
 * Three names shipped that way (`FolderKanban`, `History`, `Building2`): the
 * homepage's feature row and use-case cards drew blank squares. These
 * assertions cover the committed defaults, which are ours to keep correct.
 */
describe("icon names used by committed content resolve", () => {
  const sources: { label: string; names: string[] }[] = [
    { label: "tools", names: tools.map((t) => t.icon) },
    { label: "features", names: features.map((f) => f.icon) },
    { label: "useCases", names: useCases.map((u) => u.icon) },
    { label: "trust", names: trustItems.map((t) => t.icon) },
    { label: "aiTools", names: aiTools.map((t) => t.icon) },
    { label: "howItWorks", names: workflowSteps.map((s) => s.icon) },
    { label: "productHighlights", names: productHighlights.map((h) => h.icon) },
  ];

  it.each(sources)("$label names are all in the icon map", ({ names }) => {
    const missing = Array.from(new Set(names.filter((n) => !isKnownIconName(n))));
    expect(missing, `unmapped icon names: ${missing.join(", ")}`).toEqual([]);
  });

  it("exposes a non-trivial map", () => {
    // Guards against the map being emptied and every assertion above passing
    // vacuously.
    expect(ICON_NAMES.length).toBeGreaterThan(30);
  });
});
