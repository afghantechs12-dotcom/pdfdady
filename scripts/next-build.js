/* global process, require */
/**
 * Cross-platform build wrapper.
 * Sets NODE_OPTIONS so that Next.js worker processes spawned during static
 * page generation also receive the heap limit — the --max-old-space-size flag
 * on the parent process alone does not propagate to workers.
 *
 * VIPS_CONCURRENCY is pinned to 1 for the same class of reason. The blog's
 * `opengraph-image` routes rasterize SVG through sharp/libvips, and static
 * generation runs them across one worker per core. libvips keeps its *own*
 * thread pool per worker outside the V8 heap, so on a machine with less free
 * RAM than cores the pools collectively exhaust memory and the build dies with
 * "vips_tracked: out of memory" — a failure that depends on the host's free
 * memory rather than on anything in the source. Serializing libvips costs a
 * couple of seconds on a build that is already dominated by compilation, and
 * removes a machine-dependent failure.
 */
const { spawnSync } = require("child_process");
const result = spawnSync(
  process.execPath,
  ["node_modules/next/dist/bin/next", "build"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_OPTIONS: "--max-old-space-size=4096",
      VIPS_CONCURRENCY: process.env.VIPS_CONCURRENCY ?? "1",
    },
  },
);
process.exit(result.status ?? 1);
