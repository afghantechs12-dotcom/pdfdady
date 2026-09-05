/* global URL */
/**
 * The supported production entry point.
 *
 * `node ingress/server.mjs` — not `node server.js`, and not `next start`. The
 * difference is that this installs the ingress guard before Next creates its
 * `http.Server`, so a request is refused on the request line rather than after
 * Next has retained up to `proxyClientMaxBodySize` of its body. Starting the
 * generated entry directly is not a supported topology and does not silently
 * degrade: `src/infrastructure/config/startupGate.ts` sees that the guard is not
 * installed and exits 1 in production before a single request is handled.
 *
 * Order matters and is the whole point of the file:
 *
 *   1. `installIngress()` patches `http.createServer`, so the server Next is
 *      about to build is the one that gets guarded.
 *   2. The shutdown hook is registered HERE, which is before `startServer`
 *      registers its own. Node runs signal listeners in registration order, so
 *      this one flips the guard to draining and releases the single-instance
 *      lease before Next begins its own teardown — and Next's teardown (awaiting
 *      `server.close()`) is what buys the release time to land.
 *   3. Only then is the generated standalone entry loaded, which calls
 *      `startServer`.
 *
 * Everything else about the process — the port, the hostname, the inlined
 * resolved config, `getRequestHandlers`, `resolve-routes.js`'s
 * config-headers-before-middleware ordering, the 130/143 signal exits, logging,
 * the health endpoints — belongs to Next and is untouched.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { installIngress, installShutdown } from "./guard.mjs";

/**
 * The generated entry, in the two layouts it exists in: `../server.js` when the
 * standalone output has been assembled into the image root (the Dockerfile
 * copies `ingress/` in beside it), and `../.next/standalone/server.js` when
 * running from a checkout.
 */
const CANDIDATES = ["../server.js", "../.next/standalone/server.js"];

function resolveNextEntry() {
  for (const candidate of CANDIDATES) {
    const url = new URL(candidate, import.meta.url);
    if (existsSync(fileURLToPath(url))) return url;
  }
  throw new Error(
    `[ingress] no Next standalone entry found. Looked for ${CANDIDATES.join(", ")} ` +
      `relative to ${fileURLToPath(new URL(".", import.meta.url))}. Run \`npm run build\` first.`,
  );
}

installIngress();

// Before the Next entry is loaded, so this signal listener is registered ahead of
// Next's — which is what lets the lease be released before the process exits. A
// hard kill skips it entirely, and the lease TTL is the backstop for that.
installShutdown();

await import(resolveNextEntry().href);
