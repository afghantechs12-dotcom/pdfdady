import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import type { LogLevel } from "@/src/infrastructure/config/env";

const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Structured JSON console logger — the default ILogger adapter.
 *
 * Each call emits one JSON line: `{ level, msg, ts, ...baseFields, ...fields }`.
 * Output goes to console (stdout for debug/info, stderr for warn/error) so a
 * log shipper can ingest it. Replacing this with Sentry/PostHog/ Datadog later
 * is a new adapter implementing ILogger — nothing in the application layer
 * changes.
 */
export class ConsoleLogger implements ILogger {
  constructor(
    private readonly level: LogLevel,
    private readonly baseFields: LogFields = {},
  ) {}

  debug(message: string, fields?: LogFields): void {
    this.emit("debug", message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.emit("info", message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.emit("warn", message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.emit("error", message, fields);
  }

  child(fields: LogFields): ILogger {
    return new ConsoleLogger(this.level, { ...this.baseFields, ...fields });
  }

  private emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (RANK[level] < RANK[this.level]) return;
    const payload = {
      level,
      msg: message,
      ts: new Date().toISOString(),
      ...this.baseFields,
      ...fields,
    };
    const line = JSON.stringify(sanitize(payload));
    if (level === "error" || level === "warn") {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}

/** Drop non-serializable field values (Errors, functions, undefined) gently. */
function sanitize(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v instanceof Error) out[k] = { name: v.name, message: v.message };
    else if (typeof v === "function") continue;
    else out[k] = v;
  }
  return out;
}
