import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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
    expect(cmd).toContain("exec node server.js");
    expect(cmd.indexOf("migrate deploy")).toBeLessThan(cmd.indexOf("exec node server.js"));
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
    // Read off the gate rather than restated: ADMIN_SECRET, NEXT_PUBLIC_SITE_URL
    // and DATABASE_URL are the three `productionProblems` treats as fatal when
    // absent. DATABASE_URL was missing here, so the container exited 1.
    for (const required of ["ADMIN_SECRET", "NEXT_PUBLIC_SITE_URL", "DATABASE_URL"]) {
      expect(environment.has(required), `compose does not set ${required}`).toBe(true);
      expect(environment.get(required)).not.toBe("");
    }
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

  it("keeps the database and the stored documents outside the container layer", () => {
    const mounts = serviceVolumes.map((v) => v.split(":")[1]);
    const declared = declaredVolumes();

    for (const [variable, mustLiveIn] of [
      ["DATABASE_URL", "/app/data/db"],
      ["STORAGE_LOCAL_ROOT", "/app/data/storage"],
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
