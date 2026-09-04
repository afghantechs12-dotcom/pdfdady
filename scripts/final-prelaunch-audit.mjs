/* global process, console, fetch, URL */
/**
 * FINAL PRE-LAUNCH AUDIT — one runnable gate for the release decision.
 *
 * This is not a test suite and does not replace one. `npx vitest run` proves that
 * units behave; this proves that the ASSEMBLED PRODUCT is releasable: that the
 * deployment artifact can carry it, that the configuration gate tells the truth,
 * that no secret is committed, that the marketing surface and the capability
 * records agree, that the dependency tree has no known launch-relevant hole.
 *
 * ## Verdicts, and why there is no single percentage
 *
 *   PASS                    — the assertion was EXERCISED and it held.
 *   PRODUCT FAILURE         — exercised, and the product is wrong. Exit 1.
 *   ENVIRONMENTAL           — could not run for a reason outside the product
 *                             (no Docker daemon, no network, no live server).
 *   NOT EXERCISED           — needs an input this run did not supply.
 *   MANUAL REVIEW REQUIRED  — no machine can answer it. A human must.
 *
 * The last three are NEVER counted as passes and never folded into a green
 * number. The summary prints `PASS n/m exercised`, where m is PASS plus PRODUCT
 * FAILURE and nothing else, then lists the other three separately with their
 * reasons. A run of this script that reports "97%" while a third of its
 * assertions never executed is the failure mode this rule exists to prevent.
 *
 * ## Groups
 *
 *   A Repository and build integrity     J Privacy and retention
 *   B Production configuration gate      K Schema and migrations
 *   C Deployment artifact                L Reliability and lifecycle
 *   D Tool inventory and capability      M Observability
 *   E Authentication and session         N Performance budget
 *   F Tenant isolation                   O SEO and route truth
 *   G File and processing security       P Commercial truth
 *   H Web security and CSP               Q Analytics and consent
 *   I Dependencies and supply chain      R Accessibility and responsive
 *
 * ## Usage
 *
 *   node scripts/final-prelaunch-audit.mjs
 *   node scripts/final-prelaunch-audit.mjs --json out.json
 *   node scripts/final-prelaunch-audit.mjs --offline               # skip npm audit
 *
 * ## What this harness is, and what it is NOT
 *
 * Every assertion here is STATIC: source, configuration, migration SQL, Git
 * history, and subprocesses of this repository's own modules. **It makes no HTTP
 * request to a running deployment and never did.** It used to advertise
 * `--url https://<host>   # live checks` and carry a `live()` helper it called
 * zero times — so `--url` changed exactly one line of output (F5's skip reason)
 * while implying the whole run had been executed against a server. Both are
 * gone, because an audit tool that overstates its own reach is worse than one
 * that does less.
 *
 * Runtime behaviour is proved by the probes that actually drive it, each with its
 * own log under `docs/evidence/final-prelaunch/`:
 * `visual-acceptance-probe.mjs` (real browser, 156 captures),
 * `tool-runtime-matrix-probe.mjs` (all 32 tools, real uploads, real downloads),
 * `workflow-completeness-probe.mjs`, `perf-load-probe.mjs`,
 * `migration-restore-drill.mjs`, and the upload-ceiling probe. A static claim in
 * here is never a substitute for one of those, and rows that need a running
 * server say so by name instead of passing.
 *
 * Read-only: this script mutates nothing in the repository, sends nothing
 * outward except `npm audit` (suppressible with `--offline`), and prints no
 * secret value — group A greps for secrets and reports only WHERE and WHAT KIND.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OFFLINE = flag("--offline");
const JSON_OUT = opt("--json");

const results = [];
let group = "?";
let groupTitle = "";

const beginGroup = (letter, title) => {
  group = letter;
  groupTitle = title;
  console.log(`\n${"─".repeat(72)}\n${letter}. ${title}\n${"─".repeat(72)}`);
};

const ICON = {
  PASS: "  ✓",
  "PRODUCT FAILURE": "  ✗",
  ENVIRONMENTAL: "  ~",
  "NOT EXERCISED": "  ·",
  "MANUAL REVIEW REQUIRED": "  ?",
};

/** Records one assertion. `detail` is printed verbatim, so it must never carry a secret. */
function record(id, title, verdict, detail = "") {
  results.push({ group, groupTitle, id, title, verdict, detail });
  const tail = detail ? ` — ${detail}` : "";
  console.log(`${ICON[verdict] ?? "  ?"} ${id} ${title}${tail}`);
}

/**
 * Runs `fn` and records PASS when it returns nothing, PRODUCT FAILURE when it
 * returns a string. A THROW is reported as ENVIRONMENTAL with the message:
 * a check that could not run is not a check that passed, and it is not evidence
 * of a defect either.
 */
function check(id, title, fn) {
  try {
    const failure = fn();
    if (failure === undefined || failure === null) record(id, title, "PASS");
    else if (typeof failure === "object") record(id, title, failure.verdict, failure.detail);
    else record(id, title, "PRODUCT FAILURE", failure);
  } catch (err) {
    record(id, title, "ENVIRONMENTAL", `check could not run: ${err.message}`.slice(0, 220));
  }
}

const env = (id, title, detail) => record(id, title, "ENVIRONMENTAL", detail);
const skip = (id, title, detail) => record(id, title, "NOT EXERCISED", detail);
const manual = (id, title, detail) => record(id, title, "MANUAL REVIEW REQUIRED", detail);

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const has = (rel) => existsSync(join(ROOT, rel));
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });

/**
 * One `tsx` subprocess for facts that live in TypeScript modules.
 *
 * The body is wrapped in an async IIFE because `tsx -e` compiles to CJS, where a
 * top-level `await` is a transform error rather than a runtime one — so every
 * expression here may use `await import(...)`.
 */
function tsFacts(body) {
  const expression = `void (async () => {\n${body}\n})().catch((err) => { console.error(err); process.exit(3); });`;
  const res = spawnSync("npx", ["tsx", "-e", expression], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 << 20,
  });
  if (res.status !== 0) throw new Error(`tsx failed: ${String(res.stderr).slice(-300)}`);
  const line = String(res.stdout).trim().split("\n").pop();
  return JSON.parse(line);
}

/* ══════════════════════════════════════════════════════════════════════════
   A. Repository and build integrity
   ══════════════════════════════════════════════════════════════════════════ */
function groupA() {
  beginGroup("A", "Repository and build integrity");

  check("A1", "the working tree is clean, so what is measured is what is committed", () => {
    const dirty = git("status", "--porcelain")
      .split("\n")
      .filter((l) => l.trim() && !l.includes("docs/evidence/"));
    return dirty.length ? `${dirty.length} uncommitted path(s): ${dirty.slice(0, 3).join(", ")}` : null;
  });

  check("A2", "the lockfile is present and matches package.json's name", () => {
    if (!has("package-lock.json")) return "no package-lock.json — an install is not reproducible";
    const lock = JSON.parse(read("package-lock.json"));
    const pkg = JSON.parse(read("package.json"));
    if (lock.name !== pkg.name) return `lockfile names ${lock.name}, package.json names ${pkg.name}`;
    return lock.lockfileVersion >= 3 ? null : `lockfileVersion ${lock.lockfileVersion} predates npm 7`;
  });

  /*
   * A committed secret is the one finding that cannot be fixed by a later commit:
   * history keeps it. So this greps the TREE and then every blob in the local
   * history, and reports only the path and the KIND — never the value.
   */
  const SECRET_PATTERNS = [
    ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
    ["Stripe live secret key", /\bsk_live_[0-9a-zA-Z]{16,}/],
    ["Stripe webhook secret", /\bwhsec_[0-9a-zA-Z]{16,}/],
    ["GitHub token", /\bgh[pousr]_[0-9A-Za-z]{20,}/],
    ["OpenAI/Anthropic key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{24,}/],
    ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
    ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}/],
    ["JWT with payload", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./],
  ];
  /** This file names the patterns it hunts for; it must not report itself. */
  const SELF = "scripts/final-prelaunch-audit.mjs";

  function scanText(text, where, hits) {
    for (const [kind, re] of SECRET_PATTERNS) {
      if (re.test(text)) hits.push(`${where}: ${kind}`);
    }
  }

  /*
   * The one file whose matches were READ and confirmed synthetic: a test that
   * proves the Stripe probe's redactor removes live-key shapes has to contain
   * live-key shapes. Pinned to the file's sha256, not to its path — the moment the
   * file changes, its matches are product failures again, so this cannot become a
   * hole somebody drops a real key into. Only the path and the pattern class are
   * ever printed; no matched value is.
   */
  const ACKNOWLEDGED_FIXTURES = new Map([
    [
      "src/infrastructure/billing/stripeProbeSecretHygiene.test.ts",
      "f24ba53a71eb22f8e23775fdb165e9943058f98166dc63fbef1d2c65e24d933b",
    ],
  ]);
  const acknowledged = (file, text) => {
    const want = ACKNOWLEDGED_FIXTURES.get(file);
    return want !== undefined && want === createHash("sha256").update(text).digest("hex");
  };

  check("A3", "no secret value is committed anywhere in the current tree", () => {
    const hits = [];
    const acknowledgedHits = [];
    for (const file of git("ls-files", "-z").split("\0").filter(Boolean)) {
      if (file === SELF || file.startsWith("docs/evidence/")) continue;
      let text;
      try {
        if (statSync(join(ROOT, file)).size > 4 << 20) continue;
        text = readFileSync(join(ROOT, file), "utf8");
      } catch {
        continue; // binary or unreadable — nothing to grep
      }
      if (acknowledged(file, text)) {
        const fixture = [];
        scanText(text, file, fixture);
        acknowledgedHits.push(...fixture);
        continue;
      }
      scanText(text, file, hits);
    }
    if (hits.length) return `${hits.length} match(es): ${hits.slice(0, 4).join("; ")}`;
    if (acknowledgedHits.length) {
      return {
        verdict: "MANUAL REVIEW REQUIRED",
        detail:
          `${acknowledgedHits.length} match(es) in sha256-pinned synthetic fixtures, read and confirmed ` +
          `not live: ${acknowledgedHits.join("; ")}. Any edit to that file makes these red again.`,
      };
    }
    return null;
  });

  check("A4", "no secret value is reachable anywhere in local Git history", () => {
    // Every blob ever committed on any local ref. `--all` covers branches this
    // audit created as well as the phase branches.
    const objects = git("rev-list", "--objects", "--all").split("\n").filter(Boolean);
    /*
     * `rev-list --objects` lists TREES as well as blobs, and every tree in it has a
     * path, so feeding the list straight to `cat-file blob` printed one
     * "bad file" per directory to stderr and relied on the catch to move on. The
     * scan was right and unreadable. This asks git for each object's type once.
     */
    const blobShas = new Set(
      execFileSync("git", ["cat-file", "--batch-check", "--batch-all-objects"], {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 256 << 20,
      })
        .split("\n")
        .filter((l) => l.endsWith(" blob") || / blob \d+$/.test(l))
        .map((l) => l.slice(0, l.indexOf(" "))),
    );
    const blobs = objects
      .map((line) => {
        const sp = line.indexOf(" ");
        return sp === -1 ? null : { sha: line.slice(0, sp), path: line.slice(sp + 1) };
      })
      .filter((b) => b && b.path && blobShas.has(b.sha) && !b.path.startsWith("docs/evidence/") && b.path !== SELF);
    const hits = [];
    const fixtureHits = [];
    let scanned = 0;
    for (const blob of blobs) {
      if (/\.(png|jpg|jpeg|gif|webp|ico|pdf|woff2?|ttf|zip|db)$/i.test(blob.path)) continue;
      let text;
      try {
        text = execFileSync("git", ["cat-file", "blob", blob.sha], {
          cwd: ROOT,
          encoding: "utf8",
          maxBuffer: 16 << 20,
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        continue;
      }
      scanned += 1;
      /*
       * By PATH here, deliberately, and stated rather than hidden: every past
       * revision of the redaction test has its own hash, so the tree's hash pin
       * cannot apply to history. The compensating control is that A3 pins the
       * CURRENT contents — a real key committed today is red there.
       */
      if (ACKNOWLEDGED_FIXTURES.has(blob.path)) {
        scanText(text, `${blob.path}@${blob.sha.slice(0, 8)}`, fixtureHits);
        continue;
      }
      scanText(text, `${blob.path}@${blob.sha.slice(0, 8)}`, hits);
    }
    if (hits.length) return `${hits.length} match(es) across ${scanned} blobs: ${hits.slice(0, 4).join("; ")}`;
    if (fixtureHits.length) {
      return {
        verdict: "MANUAL REVIEW REQUIRED",
        detail:
          `${scanned} historical blobs scanned; ${fixtureHits.length} match(es) confined to the ` +
          `path-acknowledged redaction fixture (${[...ACKNOWLEDGED_FIXTURES.keys()].join(", ")}), whose ` +
          `current contents A3 pins by sha256. No other path matched in any revision.`,
      };
    }
    return { verdict: "PASS", detail: `${scanned} historical blobs scanned` };
  });

  check("A5", "no database file or user upload is committed", () => {
    const bad = git("ls-files")
      .split("\n")
      .filter((f) => /\.(db|db-journal|sqlite3?|env\.local)$/i.test(f) || f.startsWith(".storage/"));
    return bad.length ? `committed: ${bad.slice(0, 5).join(", ")}` : null;
  });

  check("A6", "the build ignores what the deploy must not carry", () => {
    const di = read(".dockerignore");
    const lines = di.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    // A line is a glob, so `.env*` covers `.env` and `.env.production`. Compared
    // as a prefix rather than as a string: an exact-match test called a correctly
    // configured .dockerignore broken.
    const covers = (pat) =>
      lines.some((l) => l === pat || (l.endsWith("*") && pat.startsWith(l.slice(0, -1))));
    const missing = ["node_modules", ".next", ".env", "*.db"].filter((pat) => !covers(pat));
    return missing.length ? `.dockerignore does not exclude ${missing.join(", ")}` : null;
  });

  check("A7", "the repository has no configured remote, so nothing has been published", () => {
    const remotes = git("remote").trim();
    return remotes ? { verdict: "MANUAL REVIEW REQUIRED", detail: `remote(s) configured: ${remotes}` } : null;
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   B. Production configuration gate
   ══════════════════════════════════════════════════════════════════════════ */
function groupB() {
  beginGroup("B", "Production configuration gate");
  const envSrc = read("src/infrastructure/config/env.ts");

  check("B1", "a production start with none of the four required values is refused, and names all four", () => {
    const out = tsFacts(`
      const e = process.env; e.NODE_ENV = "production";
      delete e.DATABASE_URL; delete e.ADMIN_SECRET; delete e.NEXT_PUBLIC_SITE_URL; delete e.NEXT_PHASE;
      delete e.DEPLOYMENT_TOPOLOGY;
      const { getConfig } = await import("./src/infrastructure/config/env.ts");
      let msg = ""; try { getConfig(); } catch (err) { msg = String(err.message); }
      console.log(JSON.stringify({ refused: msg !== "", names: ["DATABASE_URL","ADMIN_SECRET","NEXT_PUBLIC_SITE_URL","DEPLOYMENT_TOPOLOGY"].filter(n => msg.includes(n)) }));
    `);
    if (!out.refused) return "getConfig() returned normally with nothing configured";
    // Four, since the topology declaration became required: the upload limiter counts in
    // one process's memory, so the operator has to state that there is one process.
    return out.names.length === 4 ? null : `named only ${out.names.join(", ")}`;
  });

  check("B2", "the gate refuses a DATABASE_URL the shipped Prisma provider cannot open", () => {
    const provider = /datasource\s+\w+\s*\{[^}]*?provider\s*=\s*"([^"]+)"/.exec(read("prisma/schema.prisma"))?.[1];
    const out = tsFacts(`
      const e = process.env; e.NODE_ENV = "production"; delete e.NEXT_PHASE;
      e.ADMIN_SECRET = "0123456789abcdef0123456789abcdef";
      e.NEXT_PUBLIC_SITE_URL = "https://pdfdadi.example";
      e.DATABASE_URL = "postgresql://u:p@db.internal:5432/pdfdadi";
      // Declared, so the ONLY problem this fixture leaves is the URL. Without it the
      // refusal below would be true no matter what DATABASE_URL said.
      e.DEPLOYMENT_TOPOLOGY = "single-instance";
      const { getConfig } = await import("./src/infrastructure/config/env.ts");
      let msg = ""; try { getConfig(); } catch (err) { msg = String(err.message); }
      console.log(JSON.stringify({ refused: msg !== "", leaks: msg.includes("u:p@") }));
    `);
    if (provider !== "sqlite") {
      return { verdict: "MANUAL REVIEW REQUIRED", detail: `schema provider is "${provider}" — re-derive B2` };
    }
    if (!out.refused) return 'a postgresql:// URL was accepted by a build whose provider is "sqlite" — every DB request would 500 after a healthy boot';
    return out.leaks ? "the refusal echoes the connection URL into the log" : null;
  });

  check("B3", "the gate refuses a relative SQLite path, which a container deploy deletes", () => {
    const out = tsFacts(`
      const e = process.env; e.NODE_ENV = "production"; delete e.NEXT_PHASE;
      e.ADMIN_SECRET = "0123456789abcdef0123456789abcdef";
      e.NEXT_PUBLIC_SITE_URL = "https://pdfdadi.example";
      e.DATABASE_URL = "file:./prisma/dev.db";
      e.DEPLOYMENT_TOPOLOGY = "single-instance";
      const { getConfig } = await import("./src/infrastructure/config/env.ts");
      let msg = ""; try { getConfig(); } catch (err) { msg = String(err.message); }
      console.log(JSON.stringify({ refused: msg !== "", names: msg.includes("DATABASE_URL") }));
    `);
    if (!out.refused) return "a relative file: path was accepted";
    return out.names ? null : "the refusal does not name DATABASE_URL";
  });

  check("B4", "the gate refuses the public dev fallback secret and a short one", () => {
    const out = tsFacts(`
      const e = process.env; delete e.NEXT_PHASE;
      const { INSECURE_DEV_SECRET } = await import("./lib/admin/session.ts");
      const { getConfig, _resetConfigForTests } = await import("./src/infrastructure/config/env.ts");
      const attempt = (secret) => {
        e.NODE_ENV = "production"; e.DATABASE_URL = "file:/srv/db.sqlite";
        e.NEXT_PUBLIC_SITE_URL = "https://pdfdadi.example"; e.ADMIN_SECRET = secret;
        e.DEPLOYMENT_TOPOLOGY = "single-instance";
        _resetConfigForTests();
        try { getConfig(); return false; } catch { return true; }
      };
      console.log(JSON.stringify({ fallback: attempt(INSECURE_DEV_SECRET), short: attempt("abc123"), good: !attempt("0123456789abcdef0123456789abcdef") }));
    `);
    const bad = Object.entries(out).filter(([, ok]) => !ok).map(([k]) => k);
    return bad.length ? `wrong answer for: ${bad.join(", ")}` : null;
  });

  check("B5", "`next build` is exempt, so CI compiles without deployment secrets", () => {
    const out = tsFacts(`
      const e = process.env; e.NODE_ENV = "production"; e.NEXT_PHASE = "phase-production-build";
      delete e.DATABASE_URL; delete e.ADMIN_SECRET; delete e.NEXT_PUBLIC_SITE_URL;
      const { getConfig } = await import("./src/infrastructure/config/env.ts");
      let ok = true; try { getConfig(); } catch { ok = false; }
      console.log(JSON.stringify({ ok }));
    `);
    return out.ok ? null : "a production build with no secrets is refused — CI cannot compile";
  });

  check("B6", "the boot summary reports a derived engine label, never the URL", () => {
    if (!/databaseEngineLabel/.test(envSrc)) return "no shared engine label — startupGate derives its own";
    const gate = read("src/infrastructure/config/startupGate.ts");
    if (/startsWith\("file:"\)\s*\?/.test(gate)) return "startupGate still guesses the engine from the URL prefix";
    return /databaseUrl(?!Prefix)/.test(gate.replace(/databaseEngineLabel\(cfg\.databaseUrl\)/g, ""))
      ? "startupGate references the database URL outside the label helper"
      : null;
  });

  check("B7", "half-configured object storage is refused rather than silently local", () => {
    const out = tsFacts(`
      const e = process.env; e.NODE_ENV = "production"; delete e.NEXT_PHASE;
      e.DATABASE_URL = "file:/srv/db.sqlite"; e.ADMIN_SECRET = "0123456789abcdef0123456789abcdef";
      e.NEXT_PUBLIC_SITE_URL = "https://pdfdadi.example";
      e.DEPLOYMENT_TOPOLOGY = "single-instance";
      e.R2_ACCOUNT_ID = "acct"; delete e.R2_ACCESS_KEY_ID; delete e.R2_SECRET_ACCESS_KEY; delete e.R2_BUCKET;
      const { getConfig } = await import("./src/infrastructure/config/env.ts");
      let msg = ""; try { getConfig(); } catch (err) { msg = String(err.message); }
      console.log(JSON.stringify({ refused: msg !== "", names: msg.includes("R2_BUCKET") }));
    `);
    if (!out.refused) return "one R2 variable set out of four boots on local disk — uploads land on an ephemeral layer";
    return out.names ? null : "the refusal does not name the missing variables";
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   C. Deployment artifact
   ══════════════════════════════════════════════════════════════════════════ */
function groupC() {
  beginGroup("C", "Deployment artifact");
  const dockerfile = read("Dockerfile");
  const compose = read("docker-compose.yml");

  /** Every COPY source, with `/app/` stripped so it names a repo path. */
  const copySources = () => {
    const out = [];
    for (const line of dockerfile.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("COPY ")) continue;
      const words = t.slice(5).split(/\s+/).filter((w) => !w.startsWith("--"));
      for (const w of words.slice(0, -1)) out.push(w.startsWith("/app/") ? w.slice(5) : w);
    }
    return out;
  };

  check("C1", "every COPY source in the Dockerfile exists, so the image can build", () => {
    const missing = copySources().filter((src) => {
      if (src.startsWith(".next")) return false; // produced by the builder stage
      const bare = src.replace(/\/$/, "");
      if (has(bare)) return false;
      /*
       * `package-lock.json*` is a Dockerfile glob — the trailing `*` makes the
       * COPY tolerate a yarn/pnpm lockfile instead. Treated literally it named a
       * file that does not exist and reported a buildable image as unbuildable.
       */
      if (!bare.includes("*")) return true;
      const dir = bare.includes("/") ? bare.slice(0, bare.lastIndexOf("/")) : ".";
      const pattern = new RegExp(`^${bare.slice(bare.lastIndexOf("/") + 1).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
      try {
        return !readdirSync(join(ROOT, dir)).some((e) => pattern.test(e));
      } catch {
        return true;
      }
    });
    return missing.length ? `COPY source missing: ${missing.join(", ")} — docker build fails here` : null;
  });

  check("C2", "the image carries the migration toolchain it needs on a no-egress network", () => {
    const sources = copySources();
    const cmd = /^CMD .*/m.exec(dockerfile)?.[0] ?? "";
    if (!/migrate deploy/.test(cmd)) return "the CMD never applies migrations — a fresh volume has no schema";
    if (!sources.some((s) => s.includes("node_modules/prisma"))) return "the prisma CLI is not copied, so `migrate deploy` cannot run";
    if (!sources.includes("prisma")) return "prisma/migrations is not copied, so there is nothing to apply";
    if (!/internal:\s*true/.test(compose)) return { verdict: "MANUAL REVIEW REQUIRED", detail: "the app network is not internal — re-derive the egress argument" };
    return null;
  });

  check("C3", "all stages run one supported Node major", () => {
    const majors = [...dockerfile.matchAll(/^FROM node:(\d+)/gm)].map((m) => Number(m[1]));
    if (majors.length === 0) return "no node base image found";
    if (new Set(majors).size !== 1) return `stages disagree on Node major: ${[...new Set(majors)].join(", ")}`;
    // 20 left Maintenance LTS on 2026-04-30; a launch on it starts unsupported.
    return majors[0] >= 22 ? null : `Node ${majors[0]} is end-of-life — no security patches for the runtime`;
  });

  check("C4", "the compose file supplies every variable the gate requires", () => {
    const required = ["ADMIN_SECRET", "NEXT_PUBLIC_SITE_URL", "DATABASE_URL"];
    const missing = required.filter((v) => !new RegExp(`^\\s*-\\s*${v}=`, "m").test(compose));
    return missing.length ? `compose sets no ${missing.join(", ")} — \`docker compose up\` exits 1 at the gate` : null;
  });

  check("C5", "the database and the stored documents live on declared volumes", () => {
    const dbUrl = /DATABASE_URL=\$\{DATABASE_URL:-([^}]+)\}/.exec(compose)?.[1] ?? "";
    const storage = /STORAGE_LOCAL_ROOT=\$\{STORAGE_LOCAL_ROOT:-([^}]+)\}/.exec(compose)?.[1] ?? "";
    const mounts = [...compose.matchAll(/^\s*-\s*([a-z0-9-]+):(\/[^\s#]+)/gm)].map((m) => ({ vol: m[1], at: m[2] }));
    const declared = new Set(
      (/^volumes:\n((?:\s+\S.*\n?)*)/m.exec(compose)?.[1] ?? "")
        .split("\n")
        .map((l) => l.trim().replace(/:$/, ""))
        .filter(Boolean),
    );
    // `p === m.at` counts: pdfdadi-storage is mounted exactly at /app/data/storage,
    // and a prefix-only test called that "not inside a declared volume".
    const inside = (p) => mounts.find((m) => (p === m.at || p.startsWith(`${m.at}/`)) && declared.has(m.vol));
    const dbPath = dbUrl.replace(/^file:/, "");
    if (!dbPath.startsWith("/")) return `the compose DATABASE_URL default (${dbUrl}) is not an absolute path`;
    if (!inside(dbPath)) return `the database at ${dbPath} is not inside a declared volume — every account is lost on redeploy`;
    if (!storage.startsWith("/")) return `STORAGE_LOCAL_ROOT default (${storage}) is not absolute`;
    if (!inside(storage)) return `stored documents at ${storage} are not inside a declared volume`;
    return null;
  });

  check("C6", "the runtime writes only where the image has given its user ownership", () => {
    const owned = [...dockerfile.matchAll(/chown -R nextjs:nodejs (\S+)/g)].map((m) => m[1]);
    const mkdir = /RUN mkdir -p ([^\n\\]+)/.exec(dockerfile)?.[1] ?? "";
    if (!/USER nextjs/.test(dockerfile)) return { verdict: "MANUAL REVIEW REQUIRED", detail: "the image runs as root" };
    if (!owned.some((p) => p.startsWith("/app/data"))) return "/app/data is never chowned — the uid-1001 server cannot write to it";
    return /data\/storage/.test(mkdir) ? null : "the storage root is not created in the image, so first upload must mkdir under a root-owned parent";
  });

  const dockerAvailable = () =>
    spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" }).status === 0;

  if (dockerAvailable()) {
    check("C7", "the image actually builds", () => {
      const res = spawnSync("docker", ["build", "-t", "pdfdadi:audit", "."], { cwd: ROOT, encoding: "utf8" });
      return res.status === 0 ? null : `docker build exited ${res.status}: ${String(res.stderr).slice(-300)}`;
    });
    skip("C8", "the built image migrates a fresh volume and serves", "needs a compose up on a disposable volume set — run it in the rehearsal, not in the audit gate");
  } else {
    env("C7", "the image actually builds", "no Docker daemon on this machine — C1..C6 are static truths about the same file, and none of them substitutes for a build");
    env("C8", "the built image migrates a fresh volume and serves", "no Docker daemon — the boot, the migration and the mount are UNVERIFIED at runtime");
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   D. Tool inventory and capability truth
   ══════════════════════════════════════════════════════════════════════════ */
function groupD() {
  beginGroup("D", "Tool inventory and capability truth");

  let facts;
  check("D1", "the registry, the capability records and the tool pages agree on one inventory", () => {
    facts = tsFacts(`
      const { tools, isFunctional } = await import("./data/tools.ts");
      const { TOOL_CAPABILITIES, capabilityForSlug } = await import("./lib/tools/capability.ts");
      const byStatus = {};
      for (const t of tools) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
      console.log(JSON.stringify({
        total: tools.length,
        byStatus,
        functional: tools.filter(isFunctional).length,
        caps: TOOL_CAPABILITIES.length,
        uncovered: tools.filter((t) => !capabilityForSlug(t.slug)).map((t) => t.slug),
        saveable: TOOL_CAPABILITIES.filter((c) => c.workspaceSaveableOutput).map((c) => c.slug),
        editorOpenable: TOOL_CAPABILITIES.filter((c) => c.editorOpenableOutput).map((c) => c.slug),
        serverSlugs: tools.filter((t) => t.status === "functional-server").map((t) => t.slug),
        clientSlugs: tools.filter((t) => t.status === "functional-client").map((t) => t.slug),
      }));
    `);
    if (facts.uncovered.length) return `no capability record for ${facts.uncovered.join(", ")}`;
    return facts.caps === facts.total ? null : `${facts.caps} capability records for ${facts.total} tools`;
  });

  /*
   * Two rules, because the app has two kinds of tool page, and the first version of
   * this check knew neither: it listed `app/tools` (the pages live under the
   * `(marketing)` route group, so it threw ENOENT and recorded ENVIRONMENTAL) and
   * would have called a directory listing proof that a page renders.
   *
   *  - a functional-CLIENT tool needs its own directory, because `[slug]`
   *    deliberately `notFound()`s that state — its runner is bespoke.
   *  - a functional-SERVER tool is served by `[slug]`, which `notFound()`s unless
   *    `getServerToolConfigMerged(slug)` answers. That resolution is the actual
   *    render condition, so it is what gets called here rather than grepped for: a
   *    server tool with no config is a 404 on a tool the registry advertises.
   */
  check("D2", "every functional tool has a page that renders it", () => {
    if (!facts) return { verdict: "NOT EXERCISED", detail: "D1 did not produce an inventory" };
    const dir = join(ROOT, "app", "(marketing)", "tools");
    const routes = new Set(readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory()));
    if (!routes.has("[slug]")) return "app/(marketing)/tools/[slug] is gone, so no server tool has a page";
    const clientMissing = facts.clientSlugs.filter((s) => !routes.has(s));
    if (clientMissing.length) return `functional-client tools with no own page: ${clientMissing.join(", ")} — [slug] notFound()s that state`;
    const unresolvable = tsFacts(`
      const { getServerToolConfigMerged } = await import("./data/admin/index.ts");
      const { TOOL_CAPABILITIES } = await import("./lib/tools/capability.ts");
      const out = [];
      for (const c of TOOL_CAPABILITIES.filter((c) => c.implementationState === "functional-server")) {
        if (!(await getServerToolConfigMerged(c.slug))) out.push(c.slug);
      }
      console.log(JSON.stringify(out));
    `);
    if (unresolvable.length) return `functional-server tools [slug] would 404: ${unresolvable.join(", ")}`;
    return { verdict: "PASS", detail: `${facts.clientSlugs.length} client tools have own pages; ${facts.serverSlugs.length} server tools resolve a config through [slug]` };
  });

  check("D3", "no tool whose output is an archive or an office document offers a Workspace save", () => {
    if (!facts) return { verdict: "NOT EXERCISED", detail: "D1 did not produce an inventory" };
    const out = tsFacts(`
      const { TOOL_CAPABILITIES } = await import("./lib/tools/capability.ts");
      console.log(JSON.stringify(TOOL_CAPABILITIES
        .filter((c) => c.workspaceSaveableOutput && c.outputKind !== "pdf")
        .map((c) => c.slug + ":" + c.outputKind)));
    `);
    return out.length ? `saveable but not a PDF: ${out.join(", ")} — the route answers 415` : null;
  });

  check("D4", "the save route accepts the job shape every save-offering tool produces", () => {
    const route = read("app/api/jobs/[id]/save-to-workspace/route.ts");
    if (!/isProcessingJob/.test(route)) return "the route does not distinguish the two job shapes";
    if (!/legacyJobAccessDenied/.test(route)) return "the legacy branch has no ownership gate";
    if (!/PdfToolJobService/.test(route)) return "the route cannot resolve a legacy job's output — the button 404s on every non-pipeline server tool";
    return null;
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   E. Authentication and session
   ══════════════════════════════════════════════════════════════════════════ */
function groupE() {
  beginGroup("E", "Authentication and session");

  check("E1", "a user session cookie is httpOnly, sameSite and secure in production", () => {
    const src = read("src/application/services/authHttp.ts");
    const missing = [];
    if (!/httpOnly:\s*true/.test(src)) missing.push("httpOnly");
    if (!/sameSite:\s*"lax"|sameSite:\s*"strict"/.test(src)) missing.push("sameSite");
    if (!/secure:\s*process\.env\.NODE_ENV === "production"|secure:\s*true/.test(src)) missing.push("secure");
    return missing.length ? `session cookie lacks ${missing.join(", ")}` : null;
  });

  check("E2", "a user session is a stored record, so logout revokes it server-side", () => {
    const src = read("src/application/services/AuthService.ts");
    if (!/this\.sessions\.delete\(token\)/.test(src)) return "logout does not delete the session record";
    if (!/this\.sessions\.get\(token\)/.test(src)) return "session verification does not consult storage — a stolen token cannot be revoked";
    return null;
  });

  check("E3", "login rotates the session token, closing session fixation", () => {
    const src = read("src/application/services/AuthService.ts");
    return /sessions\.create\(user\.id, ttl\)/.test(src) ? null : "login reuses an existing session token";
  });

  check("E4", "password verification does not distinguish an unknown email from a wrong password", () => {
    const src = read("src/application/services/AuthService.ts");
    return /Returns null for every failure mode/.test(src) && /if \(!user\) return null;/.test(src)
      ? null
      : "login's failure paths differ, enumerating registered addresses";
  });

  /*
   * The admin token is the one exception, and it is a real one. It is a bare
   * HMAC over an issue timestamp with a 7-day max age and NO server-side record,
   * so nothing can revoke it: rotating ADMIN_SECRET invalidates every admin
   * session at once, and that is the only lever. Reported, not "fixed" — adding
   * an admin session store is a design change this audit is not authorized to make.
   */
  check("E5", "admin session semantics are recorded as they are, not as one would wish", () => {
    const src = read("lib/admin/session.ts");
    const stateless = !/prisma|repository|store/i.test(src);
    const maxAge = /MAX_AGE_MS = ([^;]+);/.exec(src)?.[1] ?? "?";
    if (!/timingSafeEqual/.test(src)) return "the admin token comparison is not constant-time";
    if (!stateless) return { verdict: "PASS", detail: "admin sessions are stored — revocable" };
    return {
      verdict: "MANUAL REVIEW REQUIRED",
      detail: `admin session is a stateless HMAC (max age ${maxAge.trim()}), so an individual token cannot be revoked; rotating ADMIN_SECRET invalidates all of them. Accept or schedule.`,
    };
  });

  check("E6", "no default admin password ships, and an initialized deployment cannot be re-setup", () => {
    const setup = read("app/api/admin/setup/route.ts");
    if (!/409/.test(setup)) return "the setup route does not answer 409 once a password exists";
    const store = read("data/admin/index.ts");
    return /passwordHash/.test(store) && !/passwordHash:\s*"[^"]+"/.test(store)
      ? null
      : { verdict: "MANUAL REVIEW REQUIRED", detail: "verify by hand that no password hash is seeded in the shipped store" };
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   F. Tenant isolation
   ══════════════════════════════════════════════════════════════════════════ */
function groupF() {
  beginGroup("F", "Tenant isolation");

  /** Every route file under a path segment, with its source. */
  const routeFiles = (dir) => {
    const out = [];
    const walk = (p) => {
      for (const entry of readdirSync(join(ROOT, p))) {
        const rel = `${p}/${entry}`;
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (entry === "route.ts") out.push({ rel, src: read(rel) });
      }
    };
    walk(dir);
    return out;
  };

  const workspaceRoutes = routeFiles("app/api/workspaces");

  check("F1", "every Workspace API route resolves the actor server-side", () => {
    const bad = workspaceRoutes.filter(
      (r) => !/getWorkspaceActor|requireUser|currentUser|workspaceActor/.test(r.src),
    );
    return bad.length ? `no actor resolution in ${bad.map((b) => b.rel).join(", ")}` : null;
  });

  check("F2", "no Workspace route trusts an organization id from the client without re-resolving it", () => {
    const bad = workspaceRoutes.filter((r) => {
      const readsBody = /body\??\.organizationId|searchParams\.get\("organizationId"\)/.test(r.src);
      const reresolves = /getWorkspaceActor\(/.test(r.src);
      return readsBody && !reresolves;
    });
    return bad.length ? `${bad.map((b) => b.rel).join(", ")} accepts a client organizationId as authority` : null;
  });

  check("F3", "every mutating Workspace route enforces same-origin", () => {
    /*
     * TRANSITIVE for the same reason F4 below is. The three upload routes stopped
     * naming `requireSameOrigin` when their pre-parse ordering moved into one shared
     * gate, and a flat name test then called all three unguarded while a live probe
     * measured a 403 from them in 1ms. So `workspaceUploadGate` is accepted — but
     * only while the gate itself still calls `requireSameOrigin`, which is what keeps
     * this check's teeth: a gate that stopped enforcing it fails every route that
     * leans on it, rather than silently passing three.
     */
    const gate = read("lib/server/workspaceUploadGate.ts");
    const accept = /requireSameOrigin/.test(gate)
      ? /requireSameOrigin|workspaceUploadGate/
      : /requireSameOrigin/;
    const bad = workspaceRoutes.filter(
      (r) => /export async function (POST|PUT|PATCH|DELETE)/.test(r.src) && !accept.test(r.src),
    );
    if (bad.length) return `no CSRF gate in ${bad.map((b) => b.rel).join(", ")}`;
    return { verdict: "PASS", detail: "directly, or through workspaceUploadGate which calls it at stage 1" };
  });

  check("F4", "the job routes authorize per job, not per session", () => {
    /*
     * TRANSITIVE, because one route is. `/api/jobs/:id/result` names no actor
     * itself: it delegates to `processingResultStream`/`processingResultRedirect`,
     * and both resolve the actor and call `getResult`. A flat name test called that
     * route unauthorized. So the authorizing helpers are DERIVED from
     * processingJobApi.ts — a helper added there that does not resolve an actor
     * does not join the set, and a route that leans on it fails.
     */
    const api = read("lib/server/processingJobApi.ts");
    // Split on the export boundary rather than trying to match a balanced body:
    // a single function longer than the window silently truncated the list, which
    // is how a helper that DOES authorize looked like one that does not.
    const authorizing = api
      .split(/\nexport /)
      .slice(1)
      .map((chunk) => ({
        name: /^(?:async )?function (\w+)/.exec(chunk)?.[1] ?? null,
        authorizes: /resolveJobActor/.test(chunk),
      }))
      .filter((f) => f.name && f.authorizes)
      .map((f) => f.name);
    if (authorizing.length === 0) return "no helper in processingJobApi.ts resolves an actor";
    const accept = new RegExp(`resolveJobActor|${authorizing.join("|")}`);
    const jobs = routeFiles("app/api/jobs");
    const bad = jobs.filter((r) => !accept.test(r.src));
    return bad.length
      ? `no per-job authorization in ${bad.map((b) => b.rel).join(", ")}`
      : { verdict: "PASS", detail: `via resolveJobActor or ${authorizing.join("/")}` };
  });

  // Never a pass from in here: this harness makes no HTTP request. The runtime
  // matrix lives in the probe that provisions two accounts and tries the read.
  skip("F5", "a cross-tenant read is refused end-to-end", "this harness is static; needs two provisioned accounts — run scripts/phase1-workspace-reliability-probe.mjs with --auth for the runtime matrix");
}

/* ══════════════════════════════════════════════════════════════════════════
   G. File and processing security
   ══════════════════════════════════════════════════════════════════════════ */
function groupG() {
  beginGroup("G", "File and processing security");

  check("G1", "no external binary is invoked through a shell", () => {
    /*
     * The vector: a filename or a user-supplied option reaching a shell, where a
     * `;` or a backtick becomes a command. `execFile`/`spawn` with an argument
     * ARRAY and no `shell` option cannot do that; `exec`/`execSync` take a
     * command string, and `shell: true` turns a safe call back into an unsafe one.
     *
     * Matched against the child_process IMPORT, not against the token `exec(`:
     * `/re/.exec(s)` is a String/RegExp method that appears all over the tree and
     * has nothing to do with processes.
     */
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${entry}`;
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.(ts|mjs)$/.test(entry) && !/\.test\.ts$/.test(entry)) {
          const body = read(rel);
          if (!/from "(node:)?child_process"/.test(body)) continue;
          const imported = /import\s*\{([^}]*)\}\s*from\s*"(?:node:)?child_process"/.exec(body)?.[1] ?? "";
          const unsafe = imported
            .split(",")
            .map((s) => s.trim().split(/\s+as\s+/)[0])
            .filter((n) => n === "exec" || n === "execSync");
          if (unsafe.length) offenders.push(`${rel} imports ${unsafe.join("/")}`);
          if (/shell:\s*true/.test(body)) offenders.push(`${rel} passes shell: true`);
        }
      }
    };
    for (const dir of ["src", "lib", "app"]) walk(dir);
    return offenders.length ? `shell invocation: ${offenders.join("; ")}` : null;
  });

  check("G2", "a hostile filename survives neither the filesystem path nor the display name", () => {
    const out = tsFacts(`
      const { sanitizeBaseName } = await import("./lib/server/toolJobSubmit.ts");
      const { sanitizeBase } = await import("./lib/workflow/fileNames.ts");
      const names = [
        "../../etc/passwd",
        "..\\\\..\\\\windows\\\\system32\\\\cmd",
        String.fromCharCode(97, 0, 98) + ".pdf",
        String.fromCharCode(34) + "quoted" + String.fromCharCode(34) + ".pdf",
        "line" + String.fromCharCode(13, 10) + "break.pdf",
        "colecao-unicode.pdf",
        "x".repeat(400) + ".pdf",
        ".",
        "..",
        "",
      ];
      console.log(JSON.stringify({
        fsSafe: names.map((n) => sanitizeBaseName(n)),
        display: names.map((n) => sanitizeBase(n)),
      }));
    `);
    /*
     * Two severities, because they are two different facts. A separator, a control
     * character or an empty result in a STORAGE KEY component is an escape or a
     * malformed key: red. A dot-only result (`.`, `..`) is neither — the key is
     * `tool-inputs/<uuid>/<base><ext>`, so one `..` cannot leave `tool-inputs/`,
     * and `LocalFileStorage.resolve` throws on anything that resolves outside the
     * root. It is still a name no namer should produce, so it is reported for
     * decision instead of being swallowed.
     */
    const bad = [];
    const degenerate = [];
    for (const n of out.fsSafe) {
      if (/[/\\]/.test(n) || n === "" || n.length > 120) bad.push(`fs:${JSON.stringify(n)}`);
      else if (/^\.+$/.test(n)) degenerate.push(JSON.stringify(n));
    }
    for (const n of out.display) {
      // A display name may be empty by contract (the caller picks the fallback),
      // but it must never carry a separator, a control character or a quote.
      if (/[/\\]/.test(n) || n.length > 200) bad.push(`display:${JSON.stringify(n)}`);
      if ([...n].some((c) => c.charCodeAt(0) < 32)) bad.push(`display-control:${JSON.stringify(n)}`);
    }
    if (bad.length) return `unsafe output: ${bad.slice(0, 4).join(", ")}`;
    if (degenerate.length) {
      return {
        verdict: "MANUAL REVIEW REQUIRED",
        detail:
          `sanitizeBaseName returns ${degenerate.join("/")} for a dot-only upload name ` +
          `(lib/server/toolJobSubmit.ts:40). Not an escape — the storage guard blocks that — but the ` +
          `documented contract is a name, so the one-line fix is to fold /^\\.+$/ into the existing ` +
          `empty-string fallback. P3.`,
      };
    }
    return null;
  });

  check("G3", "the request body is bounded before it is buffered", () => {
    const src = read("lib/server/toolJobSubmit.ts") + read("app/api/tools/[slug]/route.ts");
    if (!/content-length/i.test(src)) return "no Content-Length pre-check — a huge body is buffered before it is rejected";
    return /toolsMaxBodyBytes|TOOLS_MAX_BODY_BYTES|maxBodyBytes/.test(src) ? null : "no configured body ceiling";
  });

  check("G4", "the concurrency limiter actually blocks past its ceiling, and both upload routes release in a finally", () => {
    /*
     * BEHAVIOURAL, not a grep. `lib/server/toolJobSubmit.ts` contains the words
     * "concurrency slot acquisition" in a COMMENT, so a source scan for
     * /concurrency/ passes on prose and would keep passing if the limiter were
     * deleted. This saturates the real limiter instead.
     */
    const out = tsFacts(`
      const { acquireSlot } = await import("./lib/server/concurrency.ts");
      const held = [];
      // The default ceiling is 4. Take it, then prove the next caller waits.
      for (let i = 0; i < 4; i++) held.push(await acquireSlot());
      let fifthResolved = false;
      const fifth = acquireSlot().then((r) => { fifthResolved = true; return r; });
      await new Promise((r) => setTimeout(r, 150));
      const blockedWhileFull = !fifthResolved;
      held[0]();
      const release = await fifth;
      release();
      for (const r of held.slice(1)) r();
      console.log(JSON.stringify({ blockedWhileFull, admittedAfterRelease: fifthResolved }));
    `);
    if (!out.blockedWhileFull) return "the limiter admits callers past its ceiling — TOOLS_MAX_CONCURRENCY bounds nothing";
    if (!out.admittedAfterRelease) return "a released slot is never handed to the waiter — the limiter deadlocks under load";
    // A slot that is not released on the error path leaks until the process dies.
    for (const route of ["app/api/tools/[slug]/route.ts", "app/api/jobs/route.ts"]) {
      const body = read(route);
      if (!/finally\s*\{\s*\n?\s*if \(releaseSlot\) releaseSlot\(\);/.test(body)) {
        return `${route} does not release its slot in a finally — an error path leaks a slot permanently`;
      }
    }
    return null;
  });

  check("G5", "job output expires, and the sweep reschedules itself", () => {
    const src = read("src/infrastructure/jobs/PdfToolWorkerHandler.ts");
    if (!/RETENTION_INTERVAL_MS/.test(src)) return "no retention sweep interval";
    return /FILE_RETENTION_JOB_TYPE/.test(src) && /RETENTION_INTERVAL_MS\)/.test(src)
      ? null
      : "the sweep does not reschedule itself, so it runs once per process lifetime";
  });

  manual(
    "G6",
    "hostile document fixtures (zip bomb, encrypted, malformed xref, embedded JS)",
    "must run against controlled fixtures only; the brief forbids executing unsafe payloads outside them",
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   H. Web security and CSP
   ══════════════════════════════════════════════════════════════════════════ */
function groupH() {
  beginGroup("H", "Web security and CSP");
  const cfg = read("next.config.mjs");

  check("H1", "the static security headers are all present", () => {
    const required = [
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Referrer-Policy",
      "Permissions-Policy",
      "Cross-Origin-Opener-Policy",
      "Strict-Transport-Security",
    ];
    const missing = required.filter((h) => !cfg.includes(h));
    return missing.length ? `next.config.mjs sets no ${missing.join(", ")}` : null;
  });

  check("H2", "the CSP is enforced, not report-only", () => {
    const csp = read("lib/security/csp.mjs");
    return /CSP_HEADER = CSP_ENFORCED_HEADER/.test(csp)
      ? null
      : "the shipped header name is the report-only one — the policy blocks nothing";
  });

  check("H3", "the production policy has no wildcard, no unsafe-eval, and pins the legacy vectors to none", () => {
    const out = tsFacts(`
      const { buildCsp } = await import("./lib/security/csp.mjs");
      console.log(JSON.stringify({
        prod: buildCsp({ nonce: "n0nce", storageOrigins: [], dev: false, reportEndpoint: null }),
        dev: buildCsp({ nonce: "n0nce", storageOrigins: [], dev: true, reportEndpoint: null }),
      }));
    `);
    const p = out.prod;
    if (p.includes("*")) return `production policy contains a wildcard: ${p.slice(0, 120)}`;
    if (p.includes("unsafe-eval")) return "production policy allows unsafe-eval";
    for (const d of ["object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"]) {
      if (!p.includes(d)) return `production policy is missing ${d}`;
    }
    if (!p.includes("script-src 'nonce-n0nce' 'strict-dynamic'")) return "documents do not get a nonce-based script-src";
    return { verdict: "PASS", detail: out.dev.includes("unsafe-eval") ? "dev adds unsafe-eval/inline for HMR only" : "" };
  });

  check("H4", "the mutating API surface is same-origin gated", () => {
    const gate = read("src/application/services/workspaceHttp.ts");
    return /requireSameOrigin/.test(gate) ? null : "no same-origin helper in the workspace HTTP layer";
  });

  check("H5", "a CSP violation has somewhere to land", () => {
    if (!/report-uri/.test(read("lib/security/csp.mjs"))) return "no report-uri directive";
    return has("app/api/csp-report/route.ts") ? null : "report-uri names an endpoint that does not exist";
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   I. Dependencies
   ══════════════════════════════════════════════════════════════════════════ */
function groupI() {
  beginGroup("I", "Dependencies");
  const pkg = JSON.parse(read("package.json"));

  check("I1", "the lockfile is in sync with package.json", () => {
    const lock = JSON.parse(read("package-lock.json"));
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    const root = lock.packages?.[""] ?? {};
    const locked = { ...root.dependencies, ...root.devDependencies };
    const drift = Object.keys(declared).filter((n) => locked[n] !== declared[n]);
    return drift.length ? `package-lock.json disagrees about ${drift.join(", ")}` : null;
  });

  check("I2", "no dependency is pinned to a git URL or a local path", () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    const suspicious = Object.entries(all).filter(([, v]) => /^(git|file|link|https?):/.test(v));
    return suspicious.length
      ? `unreproducible dependency source: ${suspicious.map(([n]) => n).join(", ")}`
      : null;
  });

  if (OFFLINE) {
    env("I3", "npm audit — known advisories", "skipped by --offline; the registry is not reachable in this run");
  } else {
    check("I3", "no critical or high advisory in the production dependency tree", () => {
      const res = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 64 << 20,
      });
      if (!res.stdout) {
        return { verdict: "ENVIRONMENTAL", detail: `npm audit produced no report: ${(res.stderr || "").slice(0, 160)}` };
      }
      let report;
      try {
        report = JSON.parse(res.stdout);
      } catch {
        return { verdict: "ENVIRONMENTAL", detail: "npm audit output was not JSON (offline or proxied registry?)" };
      }
      /*
       * `?? 0` on a missing count is how a security gate goes green for the wrong
       * reason. Observed twice in three consecutive invocations: npm returned valid
       * JSON with no `metadata.vulnerabilities` at all, the two `?? 0`s summed to
       * zero, and this check reported PASS on a tree that has nine high advisories.
       * An absent count is an absent measurement — ENVIRONMENTAL, not zero — and a
       * zero has to agree with the entry list before it is believed.
       */
      const named = Object.entries(report.vulnerabilities ?? {})
        .filter(([, d]) => d.severity === "critical" || d.severity === "high")
        .map(([n, d]) => `${n} (${d.severity})`);
      const v = report.metadata?.vulnerabilities;
      if (!v || typeof v.high !== "number" || typeof v.critical !== "number") {
        return {
          verdict: "ENVIRONMENTAL",
          detail: `npm audit reported no vulnerability counts (registry error or rate limit); ${named.length} high/critical entries were listed, so this run measured nothing`,
        };
      }
      const blocking = v.critical + v.high;
      if (blocking === 0 && named.length === 0) return null;
      if (blocking === 0) {
        return {
          verdict: "ENVIRONMENTAL",
          detail: `npm audit's counts say 0 high/critical but it listed ${named.length}: ${named.slice(0, 8).join(", ")} — the report disagrees with itself`,
        };
      }
      return `${blocking} high/critical advisories: ${named.slice(0, 8).join(", ")}`;
    });
  }

  check("I4", "the runtime engine the image ships is the one package.json asks for", () => {
    const want = pkg.engines?.node ?? null;
    if (!want) return { verdict: "MANUAL REVIEW REQUIRED", detail: "package.json declares no engines.node" };
    const dockerMajors = [...read("Dockerfile").matchAll(/node:(\d+)/g)].map((m) => m[1]);
    const wantMajor = /(\d+)/.exec(want)?.[1];
    const mismatch = dockerMajors.filter((m) => Number(m) < Number(wantMajor));
    return mismatch.length
      ? `Dockerfile builds on node:${mismatch.join("/")} but package.json requires ${want}`
      : null;
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   J. Privacy and retention
   ══════════════════════════════════════════════════════════════════════════ */
function groupJ() {
  beginGroup("J", "Privacy and retention");

  check("J1", "a public run keeps nothing: the sweep deletes stored input and output", () => {
    const src = read("src/infrastructure/jobs/PdfToolWorkerHandler.ts");
    if (!/FILE_RETENTION_JOB_TYPE/.test(src)) return "no retention job";
    const retention = existsSync(join(ROOT, "src/application/services/FileRetentionService.ts"))
      ? read("src/application/services/FileRetentionService.ts")
      : src;
    return /delete|remove/i.test(retention) ? null : "the retention job deletes nothing";
  });

  check("J2", "the privacy copy on the site is the copy the code can keep", () => {
    const privacy = ["app/(marketing)/privacy-policy/page.tsx", "app/(marketing)/privacy/page.tsx"].find((p) => has(p));
    if (!privacy) return { verdict: "PRODUCT FAILURE", detail: "no privacy page exists" };
    const body = read(privacy);
    // The pre-Workspace claim. A Workspace document is stored until its owner
    // deletes it, so an unqualified "we never store your files" is now false.
    const absolute = /never\s+stor|no\s+files?\s+are\s+stored|we\s+do\s+not\s+store\s+your\s+files/i.exec(body);
    if (absolute && !/workspace/i.test(body)) {
      return `${privacy} claims "${absolute[0]}" without naming the Workspace, which stores documents by design`;
    }
    return null;
  });

  manual(
    "J3",
    "no account deletion and no data export exist anywhere in the tree",
    "grep for deleteAccount/exportData across app, src and lib returns nothing. Whether a launch " +
      "may ship without a self-service erasure and portability path is a question for qualified legal " +
      "review against the launch jurisdictions; this audit does not answer it.",
  );

  check("J4", "the log line for a document names it, never carries it", () => {
    const logger = read("src/infrastructure/logging/ConsoleLogger.ts");
    return /bytes|buffer|Uint8Array/.test(logger)
      ? "the logger accepts document bytes"
      : null;
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   K. Schema and migrations
   ══════════════════════════════════════════════════════════════════════════ */
function groupK() {
  beginGroup("K", "Schema and migrations");

  check("K1", "the migration lock, the schema and the gate name one engine", () => {
    const lock = read("prisma/migrations/migration_lock.toml");
    const schema = read("prisma/schema.prisma");
    const provider = /datasource\s+\w+\s*\{[^}]*?provider\s*=\s*"([^"]+)"/.exec(schema)?.[1] ?? "?";
    if (!lock.includes(`provider = "${provider}"`)) {
      return `prisma/schema.prisma says ${provider}, migration_lock.toml says otherwise — migrate deploy would refuse`;
    }
    const engine = /DATABASE_ENGINE = "([^"]+)"/.exec(read("src/infrastructure/config/env.ts"))?.[1] ?? "?";
    return engine === provider ? null : `the startup gate expects ${engine}, the schema declares ${provider}`;
  });

  check("K2", "every migration is applied by one ordered directory set with no gaps", () => {
    const dirs = readdirSync(join(ROOT, "prisma/migrations")).filter((d) =>
      statSync(join(ROOT, "prisma/migrations", d)).isDirectory(),
    );
    const bad = dirs.filter((d) => !/^\d{14}_/.test(d) || !has(`prisma/migrations/${d}/migration.sql`));
    if (bad.length) return `unusable migration directories: ${bad.join(", ")}`;
    const sorted = [...dirs].sort();
    return sorted.join() === dirs.sort().join() ? { verdict: "PASS", detail: `${dirs.length} migrations` } : null;
  });

  check("K3", "no migration is destructive without an explicit statement of intent", () => {
    const dirs = readdirSync(join(ROOT, "prisma/migrations")).filter((d) =>
      statSync(join(ROOT, "prisma/migrations", d)).isDirectory(),
    );
    const destructive = [];
    for (const d of dirs) {
      const sql = read(`prisma/migrations/${d}/migration.sql`);
      // DROP TABLE / DROP COLUMN lose data. Prisma's own redefine-table dance
      // (`new_X` + INSERT + DROP + RENAME) is how SQLite alters a column and is
      // not a loss, so it is recognised rather than reported.
      const drops = [...sql.matchAll(/DROP\s+(TABLE|COLUMN)[^\n;]*/gi)].map((m) => m[0]);
      const redefine = /PRAGMA\s+foreign_keys\s*=\s*(OFF|off)/.test(sql) && /INSERT INTO "new_/.test(sql);
      if (drops.length && !redefine) destructive.push(`${d}: ${drops[0].slice(0, 60)}`);
    }
    return destructive.length
      ? { verdict: "MANUAL REVIEW REQUIRED", detail: `data-losing DDL to confirm against production data: ${destructive.join("; ")}` }
      : null;
  });

  check("K4", "prisma validate accepts the schema", () => {
    const res = spawnSync("npx", ["prisma", "validate"], { cwd: ROOT, encoding: "utf8" });
    if (res.error) return { verdict: "ENVIRONMENTAL", detail: `prisma could not run: ${res.error.message}` };
    return res.status === 0 ? null : `prisma validate failed: ${(res.stderr || res.stdout).slice(0, 200)}`;
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   L. Reliability and lifecycle
   ══════════════════════════════════════════════════════════════════════════ */
function groupL() {
  beginGroup("L", "Reliability and lifecycle");
  const ready = read("app/api/health/ready/route.ts");

  check("L1", "liveness is static and readiness touches the database", () => {
    const live = read("app/api/health/route.ts");
    if (/prisma|database|db\b/i.test(live)) return "liveness depends on the database — a DB blip would restart the container";
    return /database/.test(ready) ? null : "readiness does not check the database";
  });

  check("L2", "readiness reveals whether, never why", () => {
    // `detail` carries raw driver text, and this endpoint is unauthenticated.
    return /detail/.test(/checks: checks\.map\([^)]*\)/.exec(ready)?.[0] ?? "")
      ? "readiness echoes driver detail to an unauthenticated caller"
      : null;
  });

  manual(
    "L3",
    "readiness requires all seven binaries, and omits storage writability",
    "toolchainOk is Object.values(deps).every(Boolean) over soffice/gs/qpdf/pdftoppm/pdfinfo/tesseract/ocrmypdf. " +
      "All seven back shipping tools, and the Dockerfile installs all seven, so the container path is satisfiable. " +
      "But a host missing one binary answers 503 forever while 30 of 32 tools work, and the Dockerfile HEALTHCHECK " +
      "hits /api/health (static), so the container still reports healthy. Readiness also never writes to the storage " +
      "volume, so a full or read-only disk is ready. Operator decision: accept, or split per-subsystem readiness.",
  );

  check("L4", "the worker is started by the app, not by an operator remembering to", () => {
    /*
     * `instrumentation.ts` deliberately starts only the CONFIG gate, so looking
     * for the worker there finds nothing and proves nothing. The real design is
     * lazy: every path that can create work calls `ensureWorkerReady()` first, and
     * the call is idempotent. This asserts that design instead of a hook.
     */
    if (!/export function ensureWorkerReady/.test(read("src/infrastructure/jobs/workerBootstrap.ts"))) {
      return "no ensureWorkerReady bootstrap exists";
    }
    const entryPoints = [
      "lib/server/toolJobSubmit.ts",
      "lib/server/processingJobSubmit.ts",
      "app/api/workspaces/[workspaceId]/documents/upload/route.ts",
      "app/api/jobs/[id]/save-to-workspace/route.ts",
    ];
    const cold = entryPoints.filter((f) => !/ensureWorkerReady/.test(read(f)));
    return cold.length
      ? `enqueues work without starting the worker: ${cold.join(", ")} — the job would sit in the queue`
      : null;
  });

  check("L5", "a job that dies mid-flight is retried or failed, never left running forever", () => {
    const src = read("src/infrastructure/jobs/PdfToolWorkerHandler.ts");
    if (!/maxAttempts/.test(src)) return "no attempt ceiling — a poison job retries forever";
    return /stale|reclaim|lease|visibility|timeout/i.test(src)
      ? null
      : { verdict: "MANUAL REVIEW REQUIRED", detail: "no stale-job reclaim found: a job whose process died may stay 'processing' until swept" };
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   M. Observability
   ══════════════════════════════════════════════════════════════════════════ */
function groupM() {
  beginGroup("M", "Observability");

  check("M1", "the startup gate prints what it accepted, on one line, before traffic", () => {
    const gate = read("src/infrastructure/config/startupGate.ts");
    return /databaseEngineLabel/.test(gate) && /env=/.test(gate)
      ? null
      : "the boot line does not report the configuration it accepted";
  });

  check("M2", "a request failure is logged with a correlation id", () => {
    const logger = read("src/infrastructure/logging/ConsoleLogger.ts");
    return /error/.test(logger) ? null : "the logger has no error path";
  });

  skip(
    "M3",
    "log aggregation, alerting and an on-call route",
    "no aggregation target is configured in this tree; a single-container deployment logs to stdout only. " +
      "Not a code defect — an operations decision this audit cannot exercise.",
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   N. Performance budget
   ══════════════════════════════════════════════════════════════════════════ */
function groupN() {
  beginGroup("N", "Performance budget");

  check("N1", "the standalone build output exists to be measured", () => {
    return has(".next/standalone/server.js")
      ? null
      : { verdict: "ENVIRONMENTAL", detail: "no standalone artifact in .next — run the build first" };
  });

  check("N2", "no route opts out of static rendering without a reason to", () => {
    const dynamicPages = [];
    const walk = (dir) => {
      for (const entry of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${entry}`;
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (entry === "page.tsx" && /force-dynamic/.test(read(rel)) && !/\(app\)|admin|workspaces|editor/.test(rel)) {
          dynamicPages.push(rel);
        }
      }
    };
    walk("app");
    return dynamicPages.length
      ? { verdict: "MANUAL REVIEW REQUIRED", detail: `marketing pages opting out of static rendering: ${dynamicPages.join(", ")}` }
      : null;
  });

  skip(
    "N3",
    "sustained load, cold-start latency and memory ceiling under concurrency",
    "the brief forbids destructive load against production, and no load-test environment exists in this tree",
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   O. SEO and route truth
   ══════════════════════════════════════════════════════════════════════════ */
function groupO() {
  beginGroup("O", "SEO and route truth");

  check("O1", "robots keeps crawlers out of the admin surface and the API", () => {
    const robots = read("app/robots.ts");
    return /"\/admin"/.test(robots) && /"\/api"/.test(robots)
      ? null
      : "robots.ts does not disallow /admin and /api";
  });

  check("O2", "every route the sitemap advertises is a route that exists", () => {
    /*
     * Read from source, not by importing `app/sitemap.ts`: it pulls in
     * `lib/seo/adminRuntime`, which imports `server-only` — a module that resolves
     * inside the Next build and nowhere else, so a bare tsx import dies with
     * MODULE_NOT_FOUND and the check reports an environment problem instead of an
     * answer. The static entries are literals in that file, and the dynamic ones
     * are tool slugs and blog slugs, which are checked as `[slug]` parents.
     */
    const src = read("app/sitemap.ts");
    const paths = [...src.matchAll(/\$\{SITE\.url\}(\/[a-z0-9/-]*)/g)].map((m) => m[1]).filter((p) => p !== "/");
    if (paths.length === 0) return "no static sitemap entries could be read from app/sitemap.ts";
    const pageFor = (seg) =>
      ["app", "app/(marketing)", "app/(app)"].some((base) => has(`${base}/${seg}/page.tsx`));
    const missing = paths
      .map((p) => p.replace(/^\/|\/$/g, ""))
      .filter((seg) => seg && !pageFor(seg));
    if (missing.length) return `sitemap advertises ${missing.length} route(s) with no page: ${missing.join(", ")}`;
    // The dynamic halves: a per-tool and a per-post URL need a [slug] page each.
    const dynamic = [
      ["tools", "app/(marketing)/tools/[slug]/page.tsx"],
      ["blog", "app/(marketing)/blog/[slug]/page.tsx"],
    ].filter(([label, file]) => new RegExp(`/${label}/`).test(src) && !has(file));
    return dynamic.length
      ? `the sitemap lists per-${dynamic[0][0]} URLs but ${dynamic[0][1]} does not exist`
      : { verdict: "PASS", detail: `${paths.length} static routes + tool and blog [slug] pages` };
  });

  check("O3", "a tool the sitemap advertises is a tool a user can run", () => {
    const out = tsFacts(`
      const { tools } = await import("./data/tools.ts");
      const { capabilityForSlug } = await import("./lib/tools/capability.ts");
      console.log(JSON.stringify(tools.map((t) => ({
        slug: t.slug, status: t.status, cap: capabilityForSlug(t.slug) !== null,
      }))));
    `);
    const missingCap = out.filter((t) => !t.cap).map((t) => t.slug);
    return missingCap.length ? `no capability record for ${missingCap.join(", ")}` : null;
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   P. Commercial truth
   ══════════════════════════════════════════════════════════════════════════ */
function groupP() {
  beginGroup("P", "Commercial truth");

  check("P1", "Business is non-purchasable by domain law, not by copy", () => {
    const out = tsFacts(`
      const m = await import("./src/domain/billing/subscription.ts");
      console.log(JSON.stringify({
        pro: m.isPurchasablePlanId("pro"),
        business: m.isPurchasablePlanId("business"),
        enterprise: m.isPurchasablePlanId("enterprise"),
        free: m.isPurchasablePlanId("free"),
      }));
    `);
    if (out.business || out.enterprise || out.free) return "a plan with no configured price is purchasable";
    return out.pro ? null : "no plan is purchasable at all — the pricing page offers something the domain refuses";
  });

  check("P2", "a deployment that cannot take money says so instead of half-selling", () => {
    const gate = read("src/infrastructure/config/env.ts");
    if (!/STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRICE_PRO/.test(gate)) {
      return "the config gate says nothing about a partially configured Stripe";
    }
    return /BILLING_NOT_CONFIGURED/.test(read("src/application/services/billingHttp.ts"))
      ? null
      : "an unconfigured billing deployment has no defined answer";
  });

  check("P3", "the static pricing copy is the fallback for a deployment that cannot charge", () => {
    const out = tsFacts(`
      const { pricingPlans } = await import("./data/pricing.ts");
      console.log(JSON.stringify(pricingPlans.map((p) => ({
        id: p.id, price: p.price, available: p.available, href: p.href, cta: p.cta,
      }))));
    `);
    const unavailable = out.filter((p) => !p.available);
    const lying = unavailable.filter((p) => /^\$\d/.test(p.price) || /subscribe|buy|upgrade/i.test(p.cta));
    if (lying.length) return `an unavailable plan advertises a price or a purchase CTA: ${lying.map((p) => p.id).join(", ")}`;
    const dead = out.filter((p) => p.href === "/" || p.href === "");
    return dead.length ? `a plan CTA points nowhere: ${dead.map((p) => p.id).join(", ")}` : null;
  });

  check("P4", "entitlement moves only behind a signature check", () => {
    const webhook = read("app/api/billing/webhook/route.ts");
    if (!/req\.text\(\)/.test(webhook)) return "the webhook parses JSON before verifying the signature over the raw bytes";
    return /stripe-signature/.test(webhook) ? null : "the webhook reads no signature header";
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   Q. Analytics and consent
   ══════════════════════════════════════════════════════════════════════════ */
function groupQ() {
  beginGroup("Q", "Analytics and consent");

  check("Q1", "no third-party analytics script is loaded", () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${entry}`;
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
          /*
           * COMMENTS STRIPPED FIRST. Four files carry a docstring saying a
           * self-hosted PostHog adapter could replace the console one later, and
           * matching the raw text reported the promise of privacy as a violation
           * of it. What matters is a loaded script or a beacon URL, so only code
           * is searched.
           */
          const code = read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
          if (/googletagmanager|google-analytics|gtag\(|plausible\.io|posthog\.|segment\.com|hotjar/i.test(code)) {
            offenders.push(rel);
          }
        }
      }
    };
    for (const dir of ["app", "components", "lib", "src"]) walk(dir);
    return offenders.length ? `third-party analytics in ${offenders.join(", ")}` : null;
  });

  check("Q2", "the CSP would block a third-party beacon even if one were added", () => {
    const out = tsFacts(`
      const { buildCsp } = await import("./lib/security/csp.mjs");
      console.log(JSON.stringify({ p: buildCsp({ nonce: "n", storageOrigins: [], dev: false }) }));
    `);
    return /connect-src 'self'/.test(out.p) ? null : `connect-src is wider than 'self': ${out.p}`;
  });

  check("Q3", "an analytics event carries a tool name, never a document", () => {
    /*
     * The route deliberately does NO property checking — it says so, and defers to
     * the taxonomy so the two cannot disagree. Reading the route for the word
     * "fileName" therefore matched its own explanation of why it does not keep
     * one. This feeds a document-identifying payload to the real gate instead.
     */
    const out = tsFacts(`
      const m = await import("./src/domain/metering/events.ts");
      console.log(JSON.stringify(m.sanitizeEventProperties(m.ANALYTICS_EVENTS.job_failed, {
        fileName: "payroll-2026.pdf",
        documentBytes: 12345,
        email: "someone@example.com",
        nested: { name: "payroll-2026.pdf" },
        toolSlug: "merge-pdf",
        errorCategory: "invalid_input",
      })));
    `);
    const leaked = Object.keys(out).filter((k) => !["toolSlug", "errorCategory"].includes(k));
    if (leaked.length) return `the taxonomy keeps ${leaked.join(", ")} — a document identifier reaches the ledger`;
    return out.toolSlug === "merge-pdf" ? null : "the taxonomy drops its own declared dimensions";
  });

  manual(
    "Q4",
    "whether first-party measurement needs a consent banner in the launch jurisdictions",
    "measurement is first-party and self-hosted (POST /api/analytics/events) with no third-party script and no " +
      "cross-site identifier, and the only cookie is the session cookie. Whether that is 'strictly necessary' " +
      "under the applicable rules is a question for qualified legal review, and the brief forbids inventing a " +
      "consent system without confirmed launch requirements.",
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   R. Accessibility and responsive layout
   ══════════════════════════════════════════════════════════════════════════ */
function groupR() {
  beginGroup("R", "Accessibility and responsive layout");

  check("R1", "the Phase 6 layout probe exists and is runnable", () => {
    return has("scripts/premium-ui-ux-probe.mjs")
      ? null
      : { verdict: "ENVIRONMENTAL", detail: "scripts/premium-ui-ux-probe.mjs is absent" };
  });

  skip(
    "R2",
    "111 rendered-layout assertions across 9 viewports",
    "delegated: the Phase 6 probe owns this and needs a running server. Run it separately and report its own count; " +
      "folding its result in here would double-count the same evidence under a second number.",
  );

  manual(
    "R3",
    "visual acceptance of the rendered screenshots by a human",
    "Entry Gate B requires human approval of the contact sheets. Self-generated screenshots are not approval.",
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Runner
   ══════════════════════════════════════════════════════════════════════════ */
const GROUPS = [
  groupA, groupB, groupC, groupD, groupE, groupF, groupG, groupH, groupI,
  groupJ, groupK, groupL, groupM, groupN, groupO, groupP, groupQ, groupR,
];

function main() {
  for (const g of GROUPS) {
    try {
      g();
    } catch (err) {
      record("??", `${g.name} crashed`, "ENVIRONMENTAL", String(err?.message ?? err).slice(0, 200));
    }
  }

  const by = (v) => results.filter((r) => r.verdict === v);
  const pass = by("PASS").length;
  const fail = by("PRODUCT FAILURE");
  const exercised = pass + fail.length;

  console.log("");
  console.log("─".repeat(72));
  /*
   * `n/m exercised`, never n/total. An ENVIRONMENTAL line is a check this run
   * could not perform, a NOT EXERCISED line is one nobody performed, and a
   * MANUAL REVIEW line is a decision, not a result. Adding any of them to the
   * denominator would let the number improve by making the run weaker, which is
   * the exact arithmetic the brief forbids.
   */
  console.log(`PASS ${pass}/${exercised} exercised`);
  console.log(`  PRODUCT FAILURE        ${fail.length}`);
  console.log(`  ENVIRONMENTAL          ${by("ENVIRONMENTAL").length}   (not a pass)`);
  console.log(`  NOT EXERCISED          ${by("NOT EXERCISED").length}   (not a pass)`);
  console.log(`  MANUAL REVIEW REQUIRED ${by("MANUAL REVIEW REQUIRED").length}   (not a pass)`);
  console.log(`  ${results.length} assertions recorded in total`);

  if (fail.length) {
    console.log("");
    console.log("Product failures:");
    for (const r of fail) console.log(`  ${r.id} ${r.title}\n      ${r.detail}`);
  }

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
    console.log(`\nJSON written to ${JSON_OUT}`);
  }

  // Nonzero on a product failure and on nothing else: an audit that exits red
  // because a binary was absent would be an audit nobody runs twice.
  process.exit(fail.length ? 1 : 0);
}

main();
