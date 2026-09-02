import { describe, expect, it } from "vitest";
import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import { ConsoleMetrics } from "./ConsoleMetrics";
import { ConsoleTracing } from "./ConsoleTracing";
import { ConsoleAnalytics } from "./ConsoleAnalytics";
import { ConsoleErrorReporter } from "./ConsoleErrorReporter";

/** A logger that records every call so tests can assert on emitted output. */
class RecordingLogger implements ILogger {
  readonly calls: { level: string; msg: string; fields: LogFields }[] = [];
  private readonly base: LogFields;
  constructor(base: LogFields = {}) {
    this.base = base;
  }
  private record(level: string, msg: string, fields?: LogFields) {
    this.calls.push({ level, msg, fields: { ...this.base, ...fields } });
  }
  debug(msg: string, fields?: LogFields): void { this.record("debug", msg, fields); }
  info(msg: string, fields?: LogFields): void { this.record("info", msg, fields); }
  warn(msg: string, fields?: LogFields): void { this.record("warn", msg, fields); }
  error(msg: string, fields?: LogFields): void { this.record("error", msg, fields); }
  child(fields: LogFields): ILogger { return new RecordingLogger({ ...this.base, ...fields }); }
}

describe("observability local adapters", () => {
  it("ConsoleMetrics logs increment/gauge/histogram", () => {
    const log = new RecordingLogger();
    const m = new ConsoleMetrics(log);
    m.increment("tool.request", 1, { tool: "merge-pdf" });
    m.gauge("queue.depth", 3);
    m.histogram("tool.duration_ms", 42, { tool: "merge-pdf" });
    expect(log.calls).toHaveLength(3);
    expect(log.calls[0]).toMatchObject({ msg: "metric.increment", fields: { metric: "tool.request", value: 1, tool: "merge-pdf" } });
    expect(log.calls[1].fields).toMatchObject({ metric: "queue.depth", value: 3 });
    expect(log.calls[2].fields).toMatchObject({ metric: "tool.duration_ms", value: 42 });
  });

  it("ConsoleTracing logs a span with a duration on end", () => {
    const log = new RecordingLogger();
    const t = new ConsoleTracing(log);
    const span = t.startSpan("tool.process", { tool: "merge-pdf" });
    span.setAttribute("status", "ok");
    span.end();
    const spanLog = log.calls.find((c) => c.msg === "span");
    expect(spanLog).toBeTruthy();
    expect(spanLog!.fields).toMatchObject({ span: "tool.process", tool: "merge-pdf", status: "ok" });
    expect(typeof spanLog!.fields.durationMs).toBe("number");
  });

  it("ConsoleTracing span.recordError attaches the error message", () => {
    const log = new RecordingLogger();
    const span = new ConsoleTracing(log).startSpan("x");
    span.recordError(new Error("boom"));
    span.end();
    expect(log.calls[0].fields).toMatchObject({ span: "x", error: "boom" });
  });

  it("ConsoleAnalytics tracks events + identify", () => {
    const log = new RecordingLogger();
    const a = new ConsoleAnalytics(log);
    a.identify("u1", { plan: "free" });
    a.track("tool.start", { tool: "merge-pdf" });
    const tracked = log.calls.find((c) => c.msg === "analytics");
    expect(tracked).toBeTruthy();
    expect(tracked!.fields).toMatchObject({ event: "tool.start", userId: "u1", plan: "free", tool: "merge-pdf" });
  });

  it("ConsoleErrorReporter captures errors + messages", () => {
    const log = new RecordingLogger();
    const r = new ConsoleErrorReporter(log);
    r.capture(new Error("boom"), { route: "/api/tools/merge-pdf" });
    r.captureMessage("something off", { route: "/api/auth/login" });
    expect(log.calls).toHaveLength(2);
    expect(log.calls[0]).toMatchObject({ level: "error", msg: "error.reported" });
    expect(log.calls[0].fields).toMatchObject({ name: "Error", message: "boom", route: "/api/tools/merge-pdf" });
    expect(log.calls[1].fields).toMatchObject({ message: "something off", route: "/api/auth/login" });
  });
});
