import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultStore } from "./index";
import { PROCESSING_MODE_COPY } from "@/lib/tools/processingMode";

/**
 * The footer card states the product's processing promise.
 *
 * It used to read "Made with 💜 for your documents." — the one panel in the
 * footer that told the reader nothing, in the position with the most room to
 * say something true. (Launch polish P2-15.)
 *
 * The second assertion here is the one that actually caught a bug: the shipped
 * copy comes from `data/admin/store.json` (the file-backed admin store), which
 * merges *over* `defaultStore`. Editing only the TypeScript default left the
 * old string rendering on the live page, because the JSON snapshot still held
 * it. Any future edit to this copy has to touch both, and this test says so.
 */

const store = JSON.parse(
  readFileSync(join(__dirname, "store.json"), "utf8"),
) as { site: { footerCardTitle: string; footerCardSubtitle: string } };

describe("footer trust card", () => {
  it("says something about how files are processed", () => {
    expect(defaultStore.site.footerCardTitle).toBe("Processing transparency");
    expect(defaultStore.site.footerCardSubtitle).toMatch(/browser/i);
    expect(defaultStore.site.footerCardSubtitle).toMatch(/workspace/i);
  });

  it("no longer ships the decorative placeholder", () => {
    expect(defaultStore.site.footerCardTitle).not.toMatch(/made with/i);
    expect(store.site.footerCardTitle).not.toMatch(/made with/i);
  });

  it("the persisted admin store agrees with the default", () => {
    // The store overrides the default, so a mismatch means the page renders
    // something other than what the source says.
    expect(store.site.footerCardTitle).toBe(defaultStore.site.footerCardTitle);
    expect(store.site.footerCardSubtitle).toBe(defaultStore.site.footerCardSubtitle);
  });

  it("names the three modes the way the canonical source does", () => {
    // Not a duplicated mode description — the card paraphrases, but it must not
    // invent a fourth mode or rename one. Guards against the footer drifting
    // away from PROCESSING_MODE_COPY.
    const copy = defaultStore.site.footerCardSubtitle.toLowerCase();
    for (const mode of Object.values(PROCESSING_MODE_COPY)) {
      expect(copy).toContain(mode.label.toLowerCase());
    }
  });
});
