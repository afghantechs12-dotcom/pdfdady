import { configWarnings, getConfig } from "@/src/infrastructure/config/env";

/**
 * Boot-time production gate, Node-only.
 *
 * This lives apart from `instrumentation.ts` for a concrete reason: Next compiles
 * the instrumentation hook for BOTH the Node and Edge runtimes, and a static
 * reference to `process.exit` fails the Edge compile even when a runtime guard
 * means it can never execute there. Keeping the Node API behind a dynamic import
 * from the hook keeps it out of the Edge bundle entirely.
 *
 * No configuration policy lives here. `env.ts` owns both the gate
 * (`productionProblems`) and the non-fatal warnings (`configWarnings`); this
 * module decides only WHEN to ask and WHAT to do with a "no".
 *
 * Logging is `console` rather than the DI container's ILogger on purpose:
 * resolving the container would eagerly construct Prisma and the queue adapters
 * at process start, which is a startup-behaviour change this hook has no business
 * making. Nothing below prints a secret value — only provider selections and
 * on/off flags.
 */

/** Provider selections and on/off flags only — never a secret value. */
function startupSummary(): string {
  const cfg = getConfig();
  for (const warning of configWarnings(cfg)) console.warn(`[startup] ${warning}`);
  return [
    `env=${cfg.nodeEnv}`,
    `db=${cfg.databaseUrl.startsWith("file:") ? "sqlite" : "postgres"}`,
    `storage=${cfg.storage.provider}`,
    `queue=${cfg.queue.provider}`,
    `billing=${cfg.billing.enabled ? "enabled" : "disabled"}`,
    `usageLimits=${process.env.USAGE_LIMIT_MODE ?? "observe"}`,
    `logLevel=${cfg.logLevel}`,
  ].join(" ");
}

/**
 * Runs the gate. Returns normally when the deployment is safe to serve; in
 * production, terminates the process when it is not. Rethrows either way so a
 * caller (and `next dev`) still sees the failure.
 */
export function runStartupGate(): void {
  try {
    console.info(`[startup] PDFDadi configuration OK — ${startupSummary()}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[startup] PDFDadi refused to start.\n${message}`);
    // In production, do not serve traffic on a configuration we have just
    // declared unsafe. Exiting here (rather than only rethrowing) makes the
    // failure unambiguous to a supervisor, Docker or systemd: the container dies
    // with a non-zero code and the operator sees the list above, instead of a
    // process that stays up and 500s every request.
    if (process.env.NODE_ENV === "production") process.exit(1);
    // Outside production the gate never fires; reaching here means the env schema
    // itself is invalid (e.g. LOG_LEVEL=verbose). Rethrow so `next dev` shows it
    // as a real startup error rather than swallowing it.
    throw err;
  }
}
