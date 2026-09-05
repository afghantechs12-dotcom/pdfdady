/**
 * Next.js startup hook — runs once per server process, before the first request
 * is served, in both `next dev` and `next start`.
 *
 * Its whole job is to make a misconfigured production deployment fail at BOOT
 * rather than per-request. The gate itself lives in `getConfig()`
 * (src/infrastructure/config/env.ts); running it here just moves the moment of
 * truth from "the first user who happens to hit a route that reads config" to
 * "the process refused to start, here is the list".
 *
 * Next compiles this file for BOTH the Node and Edge runtimes, so it must stay
 * free of Node-only APIs even on paths the Edge runtime can never reach — a
 * static `process.exit` reference alone fails the Edge compile. Hence the
 * dynamic import: the gate's Node-only work stays out of the Edge bundle.
 */
export async function register(): Promise<void> {
  // The Edge runtime gets its own register() call. It has no process.exit and
  // does not run the Node config path, so the gate belongs to the Node server.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runStartupGate } = await import("@/src/infrastructure/config/startupGate");
  runStartupGate();

  // Only after the configuration is known good: the lease is a database write, and
  // a deployment with an invalid DATABASE_URL should fail on the gate's list rather
  // than on a connection error. Awaited, so no request is served before this
  // process knows whether it is the one instance — and if it is not, the ingress
  // guard is already answering 503 from the moment the port was bound.
  const { startInstanceLease } = await import("@/src/infrastructure/config/instanceLease");
  await startInstanceLease();
}
