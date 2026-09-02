import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Registration must state the terms the user is accepting exactly once.
 *
 * The page previously showed two different consent models for the same action:
 * an affirmative, validated checkbox ("I agree to the Terms of Service and
 * Privacy Policy") *and* a passive line under the card ("By continuing you
 * agree to our Terms"). Beyond looking unfinished, the two disagreed — the
 * passive line named only the Terms, while the checkbox that actually gates the
 * account also covers the Privacy Policy. The affirmative checkbox is the one
 * that survives, because it is the one the server validates.
 *
 * These assertions read the source: the test environment is Node with no DOM
 * renderer, so this is the level at which the contract can be checked honestly.
 * (Launch polish P2-14.)
 */

const ROOT = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

/**
 * Strips comments so the assertions measure copy the user can actually read.
 * Without this, prose *explaining* the rule (including the comment above, and
 * the one on the register page recording why the duplicate was removed) counts
 * as a violation of it.
 */
function renderedSource(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("registration legal consent is stated once", () => {
  const page = renderedSource(read("app", "register", "page.tsx"));
  const form = renderedSource(read("components", "auth", "SignupForm.tsx"));

  it("the form keeps the affirmative, validated consent checkbox", () => {
    expect(form).toContain('name="acceptedTerms"');
    expect(form).toContain("I agree to the");
    expect(form).toContain("Terms of Service");
    expect(form).toContain("Privacy Policy");
  });

  it("the page shell does not restate consent passively", () => {
    // The duplicate that shipped. Matched case-insensitively so a reworded
    // variant ("by continuing, you agree…") is caught too.
    expect(page).not.toMatch(/by continuing[^<]*agree/i);
  });

  it("consent is claimed in exactly one place across the two files", () => {
    const mentions = (source: string) =>
      (source.match(/\bagree\b/gi) ?? []).length;
    expect(mentions(page)).toBe(0);
    // The form states it once, in the checkbox label.
    expect(mentions(form)).toBe(1);
  });
});
