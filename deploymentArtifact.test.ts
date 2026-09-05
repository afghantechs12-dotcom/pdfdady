import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { binaryInfo } from "@/lib/server/dependencyCheck";
import { productionProblems } from "@/src/infrastructure/config/env";
import { STREAMING_ROUTE_PATTERNS, classifyPath } from "./ingress/policy.mjs";

/**
 * R3 — the containerized deployment path, checked against the repository it
 * deploys.
 *
 * WHY THESE ARE ASSERTIONS AND NOT A `docker build`. Every claim below is a
 * relationship between two files in this tree — a `COPY` source and the path it
 * names, a variable the boot gate requires and the compose file that supplies it,
 * a mount point and the value that resolves inside it. `docker build` would prove
 * them too, and more besides, but it needs a Docker daemon that CI and this
 * machine may not have, and a failure there arrives as a wall of build output
 * rather than as the name of the broken line. These run in the same suite as
 * everything else.
 *
 * WHAT THEY DO NOT PROVE, said plainly: that the image builds, that the migration
 * step succeeds, that the volumes mount, or that the app serves. Those need a
 * daemon and are recorded as NOT EXERCISED in the audit. What is pinned here is
 * that the deployment files cannot silently return to states that were all four
 * separately fatal — a COPY of a directory that does not exist, a container the
 * gate refuses to boot, a database with no tables, and live data in the image's
 * writable layer.
 */

const root = process.cwd();
const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
const composeText = readFileSync(path.join(root, "docker-compose.yml"), "utf8");

/*
 * Compose is read with two small readers rather than a YAML library. `yaml` is not
 * a dependency of this project — it resolves today only because something else
 * installed it, and a test that imports a package nobody declared breaks on the
 * dependency bump that drops it. The two shapes needed here are a list of
 * `- KEY=value` strings and a list of `- name:/path` strings, which is a line
 * split, and adding a parser to a lockfile to avoid one is the wrong trade.
 */
function listItems(block: string): string[] {
  const start = composeText.indexOf(`\n${block}:`);
  if (start === -1) return [];
  const lines = composeText.slice(start + 1).split("\n").slice(1);
  const items: string[] = [];
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (!item) break; // dedented out of the block
    items.push(item[1].trim());
  }
  return items;
}

/** Top-level `volumes:` keys — the declared named volumes. */
function declaredVolumes(): string[] {
  const start = composeText.indexOf("\nvolumes:\n");
  if (start === -1) return [];
  const names: string[] = [];
  for (const line of composeText.slice(start + 1).split("\n").slice(1)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const key = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (!key) break;
    names.push(key[1]);
  }
  return names;
}

const serviceVolumes = listItems("    volumes");
const environment = new Map(
  listItems("    environment").map((line) => {
    const at = line.indexOf("=");
    return [line.slice(0, at), line.slice(at + 1)] as const;
  }),
);

/**
 * Compose's `environment:` block as the gate will see it, resolved the way Docker
 * resolves it with nothing set in the operator's shell.
 *
 * `${X:-default}` becomes the default. `${X:?message}` has no default — compose
 * refuses to start at all without it — so it becomes a value the gate accepts,
 * because what is under test is this file's contribution and not the operator's.
 * Every key compose does not mention is left absent, which is the point: the gate
 * then sees exactly what a `docker compose up` with an empty shell would produce.
 */
const GATE_STANDIN: Record<string, string> = {
  ADMIN_SECRET: "0123456789abcdef0123456789abcdef",
  // Deferred to the shell by the documented `docker run`; compose has a default.
  NEXT_PUBLIC_SITE_URL: "https://pdfdadi.example",
  // Chosen when a probe runs, not written into a launcher: a throwaway file.
  DATABASE_URL: "file:/srv/db.sqlite",
  // Likewise throwaway, and absolute: the schema default below is `.storage/local`,
  // which the gate refuses in production — correctly, since it resolves against the
  // working directory. A launcher passing a run-time path is what should be asked
  // about here, not the value it happens to pick.
  STORAGE_LOCAL_ROOT: "/srv/storage",
  ADMIN_STORE_DIR: "/srv/admin",
};
/**
 * The schema defaults for keys a deployment need not set, because the gate reads
 * PARSED env: absent here they would be `undefined`, and the gate quotes the
 * upload budgets back at the operator in its topology message. Only the values it
 * inspects, so this stays a stand-in for zod and not a second copy of it.
 */
const SCHEMA_DEFAULTS: Record<string, string | number> = {
  STORAGE_LOCAL_ROOT: ".storage/local",
  UPLOAD_RATE_LIMIT_PER_MIN: 120,
  UPLOAD_ANON_RATE_LIMIT_PER_MIN: 20,
  UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN: 240,
};
/**
 * The same words, out of a JS `const env = {` literal handed to `spawn`.
 *
 * Only the top-level pairs, and every non-string value becomes `$RUNTIME` so the
 * shared body resolves it through GATE_STANDIN exactly as it does a shell `${X}`:
 * `DATABASE_URL: dbUrl` and `` ADMIN_SECRET: `probe-${…}` `` are values chosen when
 * the probe runs, and what is being asked is whether the KEY is set at all. An
 * explicit `undefined` is a deletion (the probe strips those keys before spawning),
 * so it is dropped here too rather than being reported as set-to-nothing.
 */
function envObjectWords(text: string): string {
  const body = /\bconst env = \{\n([\s\S]*?)\n {2}\};/.exec(text)?.[1] ?? "";
  return [...body.matchAll(/^ {4}([A-Z][A-Z0-9_]*): (.+?),?$/gm)]
    .filter(([, , value]) => value !== "undefined")
    .map(([, key, value]) => `${key}=${/^"[^"]*"$/.test(value) ? value : "$RUNTIME"}`)
    .join(" ");
}

function composeEnvForGate(): Parameters<typeof productionProblems>[0] {
  const resolved: Record<string, string> = {};
  for (const [key, raw] of environment) {
    const interp = /^\$\{([A-Za-z0-9_]+)(?::([-?])([\s\S]*))?\}$/.exec(raw);
    if (!interp) {
      resolved[key] = raw;
    } else if (interp[2] === "-") {
      resolved[key] = interp[3];
    } else {
      const standin = GATE_STANDIN[key];
      expect(standin, `no stand-in for operator-supplied ${key}`).toBeTypeOf("string");
      resolved[key] = standin;
    }
  }
  return { ...SCHEMA_DEFAULTS, ...resolved } as unknown as Parameters<typeof productionProblems>[0];
}

/**
 * The source of every `COPY`, resolved to the path in THIS repository that it
 * ultimately names.
 *
 * `--from=<stage>` is included rather than skipped, which is the whole point: the
 * line that made `docker build` impossible was `COPY --from=builder /app/public`,
 * and a check that only looked at build-context copies could not see it. Both
 * earlier stages are `/app` working directories built from this tree — `deps` from
 * `package.json`, `builder` from `COPY . .` plus the build output — so stripping
 * the `/app/` prefix maps a stage path back onto a repository path. That
 * conflates the three stages' filesystems, which is an approximation, and it is
 * the conservative direction: a path absent from all of them is absent from each.
 */
function copySources(): string[] {
  const sources: string[] = [];
  for (const line of dockerfile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("COPY ")) continue;
    const words = trimmed.slice(5).split(/\s+/).filter((w) => !w.startsWith("--"));
    // The last word is the destination.
    for (const word of words.slice(0, -1)) {
      sources.push(word.startsWith("/app/") ? word.slice("/app/".length) : word);
    }
  }
  return sources;
}

describe("R3 — the container image can be built and can serve", () => {
  it("copies only paths that exist", () => {
    const sources = copySources().filter((s) => s !== "." && !s.includes("*"));
    // Vacuously green if the reader ever stops finding lines: there are six.
    expect(sources.length).toBeGreaterThanOrEqual(6);
    for (const source of sources) {
      /*
       * Build output exists only after `next build`, and the repository's gate
       * order builds before it runs vitest. On a bare checkout there is nothing to
       * check rather than something to fail — but everything OUTSIDE `.next/`,
       * which is where the broken line lived, is checked unconditionally.
       */
      if (source.startsWith(".next/") && !existsSync(path.join(root, ".next"))) continue;
      // A COPY of a missing path is not a warning: `docker build` fails and no
      // image is produced at all. `COPY --from=builder /app/public` did exactly
      // this, for the whole life of the file, in the documented deploy path.
      expect(existsSync(path.join(root, source)), `COPY source missing: ${source}`).toBe(true);
    }
  });

  it("carries the migration toolchain the standalone output leaves behind", () => {
    // `next build --output standalone` traces the generated client, never the CLI
    // or the migration SQL, so both have to be copied deliberately.
    expect(dockerfile).toContain("/app/node_modules/prisma ./node_modules/prisma");
    expect(dockerfile).toContain("COPY --chown=nextjs:nodejs prisma ./prisma");
    expect(existsSync(path.join(root, "prisma", "migrations"))).toBe(true);
    // And it runs them before serving, not instead of serving.
    const cmd = dockerfile.slice(dockerfile.lastIndexOf("\nCMD "));
    expect(cmd).toContain("migrate deploy");
    expect(cmd).toContain("exec node ingress/server.mjs");
    expect(cmd.indexOf("migrate deploy")).toBeLessThan(cmd.indexOf("exec node ingress/server.mjs"));

    // The CMD names the CLI's entry FILE, not the `prisma` bin, because
    // node_modules/.bin is not copied into the image. A version bump that moves
    // that file leaves the build green and the container dead at boot with
    // "Cannot find module" — after the image is built and pushed. The package's
    // own `bin` field is the authority for where it is.
    const cliBin = JSON.parse(
      readFileSync(path.join(root, "node_modules", "prisma", "package.json"), "utf8"),
    ).bin.prisma;
    expect(cmd).toContain(`node_modules/prisma/${cliBin}`);
  });

  it("starts through the ingress guard, and ships it", () => {
    /*
     * The two halves of one fact, which is why they are one test: the image must
     * CONTAIN `ingress/` and must START from it. Either alone is a container that
     * exits 1 at boot — the CMD has no entry point without the copy, and the
     * generated `server.js` refuses to run in production without the guard.
     *
     * Pinned here rather than left to review because the failure mode is silent in
     * the other direction: an image that starts `server.js` on a build where the
     * startup gate has been relaxed serves every request with Next retaining up to
     * `proxyClientMaxBodySize` of its body, which is the defect this branch closes.
     */
    expect(dockerfile).toContain("COPY --chown=nextjs:nodejs ingress ./ingress");
    const cmd = dockerfile.slice(dockerfile.lastIndexOf("\nCMD "));
    expect(cmd).toContain("exec node ingress/server.mjs");
    expect(cmd).not.toMatch(/exec node server\.js/);

    // And `npm start` is the same entry: the two documented ways in agree.
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.scripts.start).toBe("node ingress/server.mjs");
  });

  it("installs a package for every binary readiness requires", () => {
    /*
     * `checkAllDependencies` fails readiness when ANY of these is absent, and the
     * container HEALTHCHECK asks /api/health, which does not look at them. So an
     * image missing one boots, reports healthy, and is drained by every load
     * balancer that reads /api/health/ready — with nothing in the deploy output
     * saying why. The apt package is taken from `binaryInfo`'s own install hint,
     * so the hint shown to a self-hosting user is pinned by the same assertion.
     */
    const installed = dockerfile.slice(
      dockerfile.indexOf("apt-get install"),
      dockerfile.indexOf("rm -rf /var/lib/apt/lists"),
    );
    expect(installed).not.toBe("");
    for (const [binary, info] of Object.entries(binaryInfo)) {
      expect(installed, `${binary} needs ${info.apt}`).toContain(info.apt);
    }
  });

  it("runs on a Node major that still receives security updates", () => {
    const majors = [...dockerfile.matchAll(/^FROM node:(\d+)/gm)].map((m) => Number(m[1]));
    expect(majors.length).toBeGreaterThan(0);
    // Node 20 went end-of-life on 2026-04-30. An EOL runtime in the image is a
    // launch blocker no application code can compensate for.
    for (const major of majors) expect(major).toBeGreaterThanOrEqual(22);
    // One major across every stage: building on one runtime and serving on
    // another is how a native module passes CI and crashes in production.
    expect(new Set(majors).size).toBe(1);
  });

  it("does not carry a developer database into the build context", () => {
    const ignored = readFileSync(path.join(root, ".dockerignore"), "utf8")
      .split("\n")
      .map((l) => l.trim());
    // `prisma/` is copied wholesale now, and `prisma/dev.db` lives there.
    expect(ignored).toContain("*.db");
  });
});

describe("R3 — the compose file starts the app it describes", () => {
  it("supplies every variable the production gate refuses to start without", () => {
    // Asked of the gate, not restated as a list. A hardcoded set of names here
    // passes forever while the gate grows a new requirement — which is how this
    // file came to set neither DATABASE_URL (container exited 1) nor, later,
    // a storage root outside the image layer. Handing `productionProblems` the
    // values compose itself resolves means the assertion is "the gate accepts
    // this file", and a requirement added tomorrow fails here tomorrow.
    expect(productionProblems(composeEnvForGate())).toEqual([]);
  });

  /**
   * The documented plain-`docker run`, checked against the same gate.
   *
   * SERVER_SETUP.md offers it as the compose-free path and says every variable in
   * it is required — and it omitted DEPLOYMENT_TOPOLOGY, so the command as printed
   * exited 1 before serving a request. Compose is guarded above; an operator who
   * copies the other block gets no such help, and the failure arrives at their
   * boot rather than in this suite. Same gate, same question, so the two paths
   * cannot diverge again.
   */
  it("prints a plain `docker run` the gate would actually boot", () => {
    const guide = readFileSync(path.join(root, "SERVER_SETUP.md"), "utf8");
    const run = /```bash\n([^`]*docker run[^`]*)```/.exec(guide)?.[1];
    expect(run, "SERVER_SETUP.md no longer contains a `docker run` block").toBeTypeOf("string");
    const flags = [...run!.matchAll(/-e\s+([A-Z][A-Z0-9_]*)=("?)([^"\n\\]*)\2/g)];
    const env: Record<string, string | number> = { ...SCHEMA_DEFAULTS, NODE_ENV: "production" };
    for (const [, key, , raw] of flags) {
      // Trimmed because the capture runs to the line continuation, not because a
      // real `-e` would carry the space.
      const value = raw.trim();
      // `"$VAR"` means "from the operator's shell", exactly as in compose.
      env[key] = value.startsWith("$") ? (GATE_STANDIN[key] ?? value) : value;
    }
    expect(productionProblems(env as unknown as Parameters<typeof productionProblems>[0])).toEqual(
      [],
    );

    // The gate cannot see a missing mount: `/app/data/admin` is an absolute path
    // whether or not a volume is behind it, so a container that stores the admin
    // password there without `-v` boots healthy and loses the password when it is
    // replaced. This block did exactly that — it mounted the database and the
    // documents and left the admin store in the container layer — so the mounts are
    // asserted here, against the same three paths compose persists.
    const targets = [...run!.matchAll(/-v\s+\S+?:(\S+)/g)].map(([, t]) => t);
    for (const dir of ["/app/data/db", "/app/data/storage", "/app/data/admin"]) {
      expect(targets, `the documented \`docker run\` stores live state in ${dir} without a volume`)
        .toContain(dir);
    }
  });

  /**
   * Every launcher that composes a production environment, checked against the
   * same gate as the two container paths.
   *
   * `scripts/restart-origin.sh` is what every probe from Stage 6 on runs the app
   * with, in production mode — so it meets the gate, and Stage 4's new
   * STORAGE_LOCAL_ROOT requirement silently made its environment incomplete. A
   * surrogate that cannot boot is discovered at the start of an audit run, hours
   * from the change that broke it; the gate can say so here instead.
   *
   * `scripts/singleton-probe.mjs` was the second half of that lesson: it composes
   * the same words into a template literal for `sh -c`, so a per-line `^export`
   * check never saw it, and the same missing variable made both of its instances
   * exit at boot. Every row about exclusion then "passed" on a standby that was
   * refusing because it had died, which is the most expensive way to be green.
   * `scripts/billing-probe.mjs` and `scripts/usage-quota-browser-probe.mjs` are the
   * third instance, and the reason this list is now exhaustive rather than "the two
   * launchers we happened to think of". They build an env OBJECT and hand it to
   * `spawn`, so neither of the two extractors above could see them, and both were
   * missing DEPLOYMENT_TOPOLOGY — required since Phase 6. The billing probe was
   * found in Stage 8 exiting 2 because its server refused to boot; the quota probe
   * had the identical gap and had simply not been re-run yet. Adding a launcher and
   * not adding it here is how this rots a fifth time.
   *
   * All four are asked the same question — does the launcher set every variable the
   * gate requires — not whether the values are right, since the paths are throwaways
   * chosen at run time. Conditionally-spread blocks (the billing probe's Stripe
   * keys) are deliberately out of scope: they are indented deeper than the top-level
   * pairs and are all-or-nothing by construction.
   */
  it.each([
    [
      "scripts/restart-origin.sh",
      (text: string) => [...text.matchAll(/^export (.+)$/gm)].map(([, words]) => words).join(" "),
    ],
    [
      "scripts/singleton-probe.mjs",
      (text: string) => /\bexport ([\s\S]*?); exec /.exec(text)?.[1] ?? "",
    ],
    ["scripts/billing-probe.mjs", envObjectWords],
    ["scripts/usage-quota-browser-probe.mjs", envObjectWords],
  ])("%s exports every variable the production gate requires", (file, exportedWords) => {
    const words = exportedWords(readFileSync(path.join(root, file), "utf8"));
    expect(words, `no exported production environment found in ${file}`).not.toBe("");
    const env: Record<string, string | number> = { ...SCHEMA_DEFAULTS };
    for (const [, key, raw] of words.matchAll(/([A-Z][A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g)) {
      // `\${X:-default}` is how a template literal writes a shell expansion it
      // does not want JS to interpolate: the backslash is the escape, not a value.
      const value = raw.replace(/^["']|["']$/g, "").replace(/\\\$/g, "$");
      // `${AUDIT_X:-default}` is what the launcher actually uses; a bare `${X}` is
      // filled in at run time (a port, a throwaway db path), and `. ./.env`
      // supplies the secrets this test must not read.
      const fallback = /^\$\{[A-Za-z0-9_]+:-([^}]*)\}$/.exec(value);
      env[key] = fallback ? fallback[1] : value.startsWith("$") ? (GATE_STANDIN[key] ?? value) : value;
    }
    // Sourced from `.env`, never from this file.
    env.ADMIN_SECRET = GATE_STANDIN.ADMIN_SECRET;
    // Both launchers exec `node ingress/server.mjs`, which loads
    // `.next/standalone/server.js`, and that entry chdirs into its own directory
    // before the app reads anything — so an unset ADMIN_STORE_DIR resolves to the
    // BUILD OUTPUT in those processes, not to the repository root this test runs
    // in. Without this line the row passes on a launcher whose server exits 1 at
    // boot, which is the Stage 4 failure again: a gate-refused process answers 0 on
    // every port and every check reads as a product bug.
    env.ADMIN_STORE_DIR ??= path.join(root, ".next", "standalone", "data", "admin");
    expect(env.NODE_ENV, `${file} must run the app in production mode`).toBe("production");
    expect(productionProblems(env as unknown as Parameters<typeof productionProblems>[0])).toEqual(
      [],
    );
  });

  it("names a database URL this Prisma schema can actually open", () => {
    const schema = readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
    const provider = /datasource\s+db\s*\{[^}]*provider\s*=\s*"([^"]+)"/.exec(schema)?.[1];
    expect(provider).toBe("sqlite");
    // The default in the compose file must match the provider in the schema. A
    // `postgres://` default would be accepted by the gate and rejected by Prisma
    // at the first query — the failure would surface as a 500, not as a refusal.
    expect(environment.get("DATABASE_URL")).toContain("file:");
  });

  /**
   * The origin is baked, not only injected.
   *
   * `next.config.mjs` builds the CSP `report-to` endpoint from
   * NEXT_PUBLIC_SITE_URL at BUILD time and Next writes it into the static headers
   * for `/_next/static/*` — the one route group `proxy.ts` deliberately does not
   * run for, so no runtime value can supply it later. Set under `environment:`
   * alone (which is where it was), the image serves documents with a reporting
   * endpoint and assets without one, and violations on the asset routes read as
   * silence. Both places, one default, or the two drift.
   */
  it("passes the public origin to the build as well as the runtime", () => {
    expect(dockerfile).toMatch(/^ARG NEXT_PUBLIC_SITE_URL$/m);
    const args = composeText.slice(composeText.indexOf("\n      args:"));
    const buildValue = /NEXT_PUBLIC_SITE_URL:\s*(\S+)/.exec(args)?.[1];
    expect(buildValue).toBe(environment.get("NEXT_PUBLIC_SITE_URL"));
  });

  /**
   * The sample proxy config in SERVER_SETUP.md raises `client_max_body_size` on the
   * paths that take a large upload, and the guide asks the reader to keep that list
   * in step with the matcher exclusions by hand. `ingress/policy.test.ts` pins those
   * exclusions against the matcher; nothing pinned the documented nginx list against
   * either, so a sixth streaming route would pass every existing test and then fail
   * at the proxy for anyone who runs one — with a 413 the app never sent.
   */
  it("the documented nginx caps cover exactly the streaming upload paths", () => {
    const guide = readFileSync(path.join(root, "SERVER_SETUP.md"), "utf8");
    const locations = [...guide.matchAll(/^\s*location ~ (\S+)/gm)].map(([, re]) => new RegExp(re));
    expect(locations.length, "no nginx `location ~` blocks found in the guide").toBeGreaterThan(0);

    // A concrete path per pattern: the regexes are anchored literals with `[^/]+`
    // segments, so one substitution yields a path the app really classifies.
    const streaming = STREAMING_ROUTE_PATTERNS.map((p) =>
      p.replace(/^\^/, "").replace(/\$$/, "").replace(/\[\^\/\]\+/g, "x"),
    );

    for (const p of streaming) {
      expect(classifyPath(p), `${p} is no longer a streaming path`).toBe("C");
      expect(locations.some((re) => re.test(p)), `no documented cap raises the proxy limit for ${p}`).toBe(true);
    }
    // And nothing else: a cap on a class B path would let 120 MiB reach an app that
    // refuses it at 2 MiB, which is the proxy absorbing a body for nothing.
    for (const p of ["/", "/api/admin/login", "/api/analytics/events", "/api/workspaces/w/documents/d"]) {
      expect(classifyPath(p), `${p} is not class C`).not.toBe("C");
      expect(locations.some((re) => re.test(p)), `a documented cap also matches ${p}`).toBe(false);
    }
  });

  it("keeps the database and the stored documents outside the container layer", () => {
    const mounts = serviceVolumes.map((v) => v.split(":")[1]);
    const declared = declaredVolumes();

    for (const [variable, mustLiveIn] of [
      ["DATABASE_URL", "/app/data/db"],
      ["STORAGE_LOCAL_ROOT", "/app/data/storage"],
      // The admin password hash and all CMS content. Compose sets the variable
      // explicitly even though the image's WORKDIR would resolve it to the same
      // place, so moving the mount without moving the variable fails here.
      ["ADMIN_STORE_DIR", "/app/data/admin"],
    ] as const) {
      const value = environment.get(variable) ?? "";
      // The value the app will resolve, not the compose interpolation around it.
      const resolved = value.replace(/^\$\{[^:}]+:-/, "").replace(/\}$/, "");
      expect(resolved.startsWith(mustLiveIn) || resolved.startsWith(`file:${mustLiveIn}`)).toBe(
        true,
      );
      expect(mounts, `${variable} resolves outside every mount`).toContain(mustLiveIn);
    }
    // A mount with no volume behind it is a bind mount of a host path that does
    // not exist. Every one of them is declared.
    for (const name of serviceVolumes.map((v) => v.split(":")[0])) {
      expect(declared).toContain(name);
    }
  });
});
