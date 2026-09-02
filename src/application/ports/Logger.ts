/**
 * Logger port — the application layer's only logging abstraction.
 *
 * Structured fields are passed alongside the message so adapters (console JSON
 * in dev/test, a structured log shipper in prod) can emit machine-parseable
 * output without the application knowing the destination. `child()` returns a
 * logger that auto-merges base fields (e.g. request id, module name).
 */
export type LogFields = Record<string, unknown>;

export interface ILogger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that prepends `fields` to every subsequent call. */
  child(fields: LogFields): ILogger;
}
