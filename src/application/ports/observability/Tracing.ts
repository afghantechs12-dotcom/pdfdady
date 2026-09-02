/**
 * Tracing port — distributed spans. `startSpan` returns a Span that records
 * attributes + duration; `end` finalizes it. The local adapter logs span
 * durations to the console; an OTel/Jaeger adapter would export real traces.
 */
export type SpanValue = string | number | boolean;
export type SpanTags = Record<string, SpanValue>;

export interface Span {
  setAttribute(key: string, value: SpanValue): void;
  /** Records an error on the span (does not end it). */
  recordError(error: Error): void;
  end(extraTags?: SpanTags): void;
}

export interface ITracing {
  startSpan(name: string, tags?: SpanTags): Span;
}
