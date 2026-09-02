import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The configuration audit for `ANALYTICS_SUBJECT_SECRET`, as tests rather than as
 * a note in a doc.
 *
 * The variable keys the daily-rotated subject pseudonym. Three things about it
 * have to stay true, and each one fails silently if it stops being true:
 *
 *  1. It is **documented**. An undocumented optional secret is one nobody sets,
 *     so funnel stitching quietly rides on `ADMIN_SECRET` forever.
 *  2. Its **fallback is deliberate**, not an oversight — and the reason is
 *     recorded where the fallback is, so a later reader does not "fix" it into a
 *     hard requirement that refuses to boot without an analytics key.
 *  3. It is **server-only**. Next.js inlines any `NEXT_PUBLIC_`-prefixed variable
 *     into the client bundle, so a rename is all it takes to publish an HMAC key.
 */

function read(...segments: string[]): string {
  return readFileSync(path.join(process.cwd(), ...segments), "utf8");
}

const NAME = "ANALYTICS_SUBJECT_SECRET";

describe("documentation", () => {
  it("is in the environment example", () => {
    const example = read(".env.example");
    expect(example).toContain(NAME);
    // Documented as optional with its fallback stated: someone reading only this
    // file has to be able to tell that leaving it unset is a supported choice.
    expect(example).toMatch(/ANALYTICS_SUBJECT_SECRET[\s\S]{0,400}/);
    const block = example.slice(example.indexOf("analytics subject pseudonym") - 200);
    expect(block).toContain("ADMIN_SECRET");
  });

  it("is in the deployment guide with its degradation described", () => {
    const guide = read("SERVER_SETUP.md");
    const index = guide.indexOf(NAME);
    expect(index).toBeGreaterThan(-1);
    const section = guide.slice(index, index + 800);
    expect(section).toMatch(/optional/i);
    expect(section).toContain("ADMIN_SECRET");
    expect(section).toContain("NEXT_PUBLIC_");
  });
});

describe("fallback", () => {
  const container = read("src/application/di/container.ts");

  it("falls back to ADMIN_SECRET and then to no hashing at all", () => {
    expect(container).toContain(
      "process.env.ANALYTICS_SUBJECT_SECRET || process.env.ADMIN_SECRET || null",
    );
  });

  it("has no hardcoded default", () => {
    // A constant salt is not a salt: every deployment would produce the same
    // pseudonym for the same visitor, which is the property the hash exists to
    // deny. `|| null` is the only acceptable final branch.
    const line = container
      .split("\n")
      .find((l) => l.includes("subjectSecret:")) ?? "";
    expect(line).toMatch(/\|\|\s*null/);
    expect(line).not.toMatch(/\|\|\s*["'`]/);
  });

  it("is absent from the validated env schema, on purpose", () => {
    // Adding it to the zod schema would make a missing analytics key a boot
    // failure. Reporting is allowed to degrade; the app is not allowed to stop.
    expect(read("src/infrastructure/config/env.ts")).not.toContain(NAME);
  });
});

describe("server-only", () => {
  it("is never read under a NEXT_PUBLIC_ name", () => {
    expect(read("src/application/di/container.ts")).not.toContain(`NEXT_PUBLIC_${NAME}`);
  });

  it("is referenced by exactly one module, and it is server-side", () => {
    // Documentation may name it; source may not, beyond the one place that reads
    // it. A second reader is how a server-only value ends up somewhere that is
    // bundled — the point of the sweep is to notice before that happens.
    expect(sourceFilesContaining(NAME)).toEqual(["src/application/di/container.ts"]);
  });

  it("is not reachable from a client component", () => {
    // The container imports Prisma, so a "use client" file importing it would
    // fail the build — but the assertion is cheap and the failure mode is a
    // published secret.
    expect(read("src/application/di/container.ts").startsWith('"use client"')).toBe(false);
    expect(read("components/app/UsageCard.tsx")).not.toContain("@/src/application/di");
    expect(read("components/admin/AnalyticsDashboard.tsx")).not.toContain("@/src/application/di");
  });
});

/** Every non-test source file under the app's own directories naming `needle`. */
function sourceFilesContaining(needle: string): string[] {
  const roots = ["app", "components", "hooks", "lib", "src", "data"];
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(rel);
      } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && !entry.name.includes(".test.")) {
        if (readFileSync(path.join(process.cwd(), rel), "utf8").includes(needle)) found.push(rel);
      }
    }
  };
  for (const root of roots) walk(root);
  return found.sort();
}
