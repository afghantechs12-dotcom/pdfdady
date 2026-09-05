/**
 * The one object shared between the ingress guard and the application bundle.
 *
 * `ingress/guard.mjs` is loaded from disk by `ingress/server.mjs` before Next
 * exists. Everything in this directory is compiled INTO the Next bundle. They are
 * therefore different module instances of anything they both import, and a plain
 * module-scoped variable would give each side its own copy — the guard would flip
 * a flag the health route could never read. `globalThis` is the only channel the
 * two share, so the state lives there and both sides reach it through the same
 * key with the same `??=` initialiser.
 *
 * Whoever runs first creates it. That matters in both directions: started through
 * `ingress/server.mjs` the guard creates it with `installed: true` before this
 * module is even compiled in, and started through the generated `server.js` this
 * module creates it with `installed: false` — which is what
 * `assertIngressInstalled()` reads to refuse to serve unguarded.
 */

const STATE_KEY = "__PDFDADI_INGRESS__";

/**
 * - `pending`  — the process has not yet tried to acquire the lease.
 * - `held`     — this process owns it, and the heartbeat is running.
 * - `refused`  — another live process owns it. This instance must not serve.
 * - `lost`     — it was held and a contender took it (or the heartbeat failed
 *                long enough to expire). Same serving consequence as `refused`,
 *                but a different operational story, so a different word.
 * - `released` — given up cleanly on shutdown.
 * - `disabled` — no lease is required (development, or a build-time phase).
 */
export type LeaseStatus = "pending" | "held" | "refused" | "lost" | "released" | "disabled";

export interface IngressState {
  /** Set by `guard.mjs` once it has wrapped a real `http.Server`. */
  installed: boolean;
  lease: LeaseStatus;
  /** One human-readable line for `/api/health/ready` and the startup log. */
  leaseDetail: string;
  refusals: { body: number; unready: number };
  /** Registered by the lease so the guard's signal handler can release it. */
  release?: () => void | Promise<void>;
}

const DEFAULTS: IngressState = {
  installed: false,
  lease: "pending",
  leaseDetail: "not yet acquired",
  refusals: { body: 0, unready: 0 },
};

/** The shared state. Same object the guard mutates. */
export function ingressState(): IngressState {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: IngressState };
  return (g[STATE_KEY] ??= { ...DEFAULTS, refusals: { ...DEFAULTS.refusals } });
}

/**
 * Refuse to serve when the guard is not in front of us.
 *
 * The whole body boundary is `guard.mjs`. Started through the generated
 * `server.js`, nothing patches `http.createServer`, no request is inspected, and
 * an anonymous 100 MiB POST to a page URL is retained again — silently, because
 * every route still behaves correctly. So an unguarded production process is not
 * a degraded deployment, it is the defect, and it exits instead.
 *
 * Development is exempt: `next dev` has its own server, and the failure this
 * guards against is a production topology mistake.
 */
export function assertIngressInstalled(): void {
  if (process.env.NODE_ENV !== "production") return;
  if (ingressState().installed) return;
  throw new Error(
    "the ingress guard is not installed. PDFDadi must be started with " +
      "`node ingress/server.mjs`, which installs the request-body boundary before Next " +
      "creates its HTTP server. Starting the generated `server.js` directly leaves every " +
      "path able to retain up to proxyClientMaxBodySize of an anonymous request body " +
      "before routing. See SERVER_SETUP.md and ingress/guard.mjs.",
  );
}
