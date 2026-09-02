import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  FORBIDDEN_CLAIMS,
  PROCESSING_MODE_COPY,
  availabilityForStatus,
  isComingLater,
  processingCopyForStatus,
  processingModeForStatus,
} from "./processingMode";
import { tools } from "@/data/tools";
import type { ToolStatus } from "@/data/tools";

const ALL_STATUSES: ToolStatus[] = [
  "functional-client",
  "functional-server",
  "planned",
  "coming-soon-ai",
];

describe("processingModeForStatus", () => {
  it("maps browser-processed tools to the browser mode", () => {
    expect(processingModeForStatus("functional-client")).toBe("browser");
  });

  it("maps server-processed tools to the secure-cloud mode", () => {
    expect(processingModeForStatus("functional-server")).toBe("secure-cloud");
  });

  it.each(["planned", "coming-soon-ai"] as const)(
    "gives %s no processing mode at all",
    (status) => {
      // A tool that cannot run has no processing location. Inventing one would
      // imply it is executable.
      expect(processingModeForStatus(status)).toBeNull();
    },
  );

  it("is total over every declared status", () => {
    for (const status of ALL_STATUSES) {
      expect(() => processingModeForStatus(status)).not.toThrow();
    }
  });
});

describe("availability", () => {
  it("treats both functional statuses as available", () => {
    expect(availabilityForStatus("functional-client")).toBe("available");
    expect(availabilityForStatus("functional-server")).toBe("available");
  });

  it("treats planned and AI tools as coming later", () => {
    expect(isComingLater("planned")).toBe(true);
    expect(isComingLater("coming-soon-ai")).toBe(true);
  });

  it("never marks a runnable tool as coming later", () => {
    expect(isComingLater("functional-client")).toBe(false);
    expect(isComingLater("functional-server")).toBe(false);
  });
});

describe("processing-mode copy", () => {
  it("supplies copy for every mode a tool can have", () => {
    for (const status of ALL_STATUSES) {
      const mode = processingModeForStatus(status);
      if (mode) expect(processingCopyForStatus(status)).toEqual(PROCESSING_MODE_COPY[mode]);
      else expect(processingCopyForStatus(status)).toBeNull();
    }
  });

  it("does not promise that browser tools are never uploaded in any context", () => {
    // The claim must be scoped to the operation, not to the product.
    const browser = PROCESSING_MODE_COPY.browser;
    expect(browser.description.toLowerCase()).toContain("this tool");
    expect(browser.detail.toLowerCase()).toContain("this operation");
  });

  it("admits that secure-cloud tools upload the file", () => {
    const cloud = PROCESSING_MODE_COPY["secure-cloud"];
    expect(cloud.description.toLowerCase()).toContain("uploaded");
    expect(cloud.detail.toLowerCase()).toContain("uploaded");
  });

  it("says Workspace files persist rather than claiming deletion", () => {
    const workspace = PROCESSING_MODE_COPY.workspace;
    expect(workspace.description.toLowerCase()).toMatch(/until you delete|archive/);
  });

  it("contains no forbidden claim in its own copy", () => {
    for (const { mode, label, description, detail } of Object.values(PROCESSING_MODE_COPY)) {
      const haystack = `${mode} ${label} ${description} ${detail}`.toLowerCase();
      for (const { phrase } of FORBIDDEN_CLAIMS) {
        expect(haystack).not.toContain(phrase);
      }
    }
  });
});

describe("the tool registry agrees with the public model", () => {
  it("gives every runnable tool exactly one processing mode", () => {
    for (const tool of tools) {
      const mode = processingModeForStatus(tool.status);
      if (tool.status === "functional-client" || tool.status === "functional-server") {
        expect(mode, `${tool.slug} must have a processing mode`).not.toBeNull();
      }
    }
  });

  it("requires every planned tool to explain why it is not available", () => {
    for (const tool of tools.filter((t) => t.status === "planned")) {
      expect(tool.plannedReason, `${tool.slug} needs a plannedReason`).toBeTruthy();
    }
  });

  it("keeps AI tools out of the available set", () => {
    const aiTools = tools.filter((t) => t.category === "ai");
    expect(aiTools.length).toBeGreaterThan(0);
    for (const tool of aiTools) {
      expect(isComingLater(tool.status), `${tool.slug} must not be available`).toBe(true);
    }
  });
});

/**
 * A scan of the user-facing source for claims the evidence matrix removed.
 *
 * This is the guard that makes the truthfulness work durable: without it,
 * "100% Secure" reappears the next time someone writes a hero section.
 */
const ROOT = join(__dirname, "..", "..");
const SCAN_DIRS = ["app", "components", "data"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(tsx?|json)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("removed marketing claims stay removed", () => {
  const files = SCAN_DIRS.flatMap((d) => sourceFiles(join(ROOT, d)));

  it("scans a meaningful number of files", () => {
    // Guards against the scan silently matching nothing and passing forever.
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(FORBIDDEN_CLAIMS)("never says \"$phrase\" ($because)", ({ phrase }) => {
    const offenders: string[] = [];
    for (const file of files) {
      // processingMode.ts declares the forbidden list itself.
      if (file.endsWith(join("lib", "tools", "processingMode.ts"))) continue;
      const text = readFileSync(file, "utf8").toLowerCase();
      if (text.includes(phrase)) offenders.push(relative(ROOT, file));
    }
    expect(offenders, `forbidden claim "${phrase}" found in: ${offenders.join(", ")}`).toEqual([]);
  });
});
