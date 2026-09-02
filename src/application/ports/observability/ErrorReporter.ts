/**
 * ErrorReporter port — captures unexpected errors + messages for alerting.
 * The local adapter logs via ILogger; a Sentry adapter (self-hosted per the
 * audit) ships errors + release health later. `context` carries request/job
 * metadata (never secrets).
 */
export interface ErrorContext {
  [key: string]: unknown;
}

export interface IErrorReporter {
  capture(error: Error, context?: ErrorContext): void;
  captureMessage(message: string, context?: ErrorContext): void;
}
