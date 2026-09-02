import type { ITracing, Span, SpanTags, SpanValue } from "@/src/application/ports/observability/Tracing";
import type { ILogger } from "@/src/application/ports/Logger";

/**
 * Local ITracing adapter — logs span start/end with the elapsed duration. An
 * OTel/Jaeger adapter replaces this in production.
 */
export class ConsoleTracing implements ITracing {
  constructor(private readonly logger: ILogger) {}

  startSpan(name: string, tags?: SpanTags): Span {
    return new ConsoleSpan(name, tags ?? {}, this.logger);
  }
}

class ConsoleSpan implements Span {
  private readonly attrs: SpanTags = {};
  private readonly startMs: number;
  private ended = false;

  constructor(
    private readonly name: string,
    tags: SpanTags,
    private readonly logger: ILogger,
  ) {
    this.startMs = Date.now();
    Object.assign(this.attrs, tags);
  }

  setAttribute(key: string, value: SpanValue): void {
    this.attrs[key] = value;
  }

  recordError(error: Error): void {
    this.attrs.error = error.message;
  }

  end(extraTags?: SpanTags): void {
    if (this.ended) return;
    this.ended = true;
    Object.assign(this.attrs, extraTags ?? {});
    this.logger.info("span", {
      span: this.name,
      durationMs: Date.now() - this.startMs,
      ...this.attrs,
    });
  }
}
