import type {
  IErrorReporter,
  ErrorContext,
} from "@/src/application/ports/observability/ErrorReporter";
import type { ILogger } from "@/src/application/ports/Logger";

/**
 * Local IErrorReporter adapter — routes captures through ILogger (error level)
 * with structured context. A Sentry adapter (self-hosted) ships errors +
 * release health later. Never logs secrets — context is operational metadata.
 */
export class ConsoleErrorReporter implements IErrorReporter {
  constructor(private readonly logger: ILogger) {}

  capture(error: Error, context?: ErrorContext): void {
    this.logger.error("error.reported", {
      name: error.name,
      message: error.message,
      ...context,
    });
  }

  captureMessage(message: string, context?: ErrorContext): void {
    this.logger.error("error.reported", { message, ...context });
  }
}
