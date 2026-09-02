import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleLogger } from "./ConsoleLogger";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ConsoleLogger", () => {
  it("emits only messages at or above the configured level", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logger = new ConsoleLogger("warn");
    logger.debug("d"); // below warn → dropped
    logger.info("i"); // below warn → dropped
    logger.warn("w"); // emitted (warn → stderr)
    logger.error("e"); // emitted (error → stderr)
    expect(log).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(2);
  });

  it("emits structured JSON with merged child fields", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logger = new ConsoleLogger("info").child({ module: "test" });
    logger.error("boom", { requestId: "r1" });
    expect(err).toHaveBeenCalledTimes(1);
    const line = err.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("error");
    expect(parsed.msg).toBe("boom");
    expect(parsed.module).toBe("test");
    expect(parsed.requestId).toBe("r1");
    expect(typeof parsed.ts).toBe("string");
  });

  it("serializes Error fields into name + message", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logger = new ConsoleLogger("info");
    logger.error("failed", { cause: new Error("boom") });
    const parsed = JSON.parse(err.mock.calls[0][0] as string);
    expect(parsed.cause).toEqual({ name: "Error", message: "boom" });
  });
});
