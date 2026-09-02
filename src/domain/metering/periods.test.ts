import { describe, expect, it } from "vitest";
import {
  msUntilReset,
  periodBoundsFor,
  periodEndFor,
  periodKeyFor,
  periodStartFor,
  retryAfterSecondsFor,
} from "./periods";

/**
 * Period arithmetic is the part of a metering system that is wrong at midnight on
 * the last day of a month and correct every other time you look at it. Every
 * test here therefore pins a specific awkward instant rather than "now".
 */
describe("day windows", () => {
  it("floors to UTC midnight", () => {
    const at = new Date("2026-08-24T13:47:11.512Z");
    expect(periodStartFor("day", at).toISOString()).toBe("2026-08-24T00:00:00.000Z");
    expect(periodEndFor("day", at).toISOString()).toBe("2026-08-25T00:00:00.000Z");
  });

  it("treats midnight itself as the start of its own window, not the previous one", () => {
    const at = new Date("2026-08-24T00:00:00.000Z");
    expect(periodStartFor("day", at).toISOString()).toBe("2026-08-24T00:00:00.000Z");
  });

  it("rolls over month and year boundaries by calendar, not by adding 24h", () => {
    expect(periodEndFor("day", new Date("2026-08-31T23:59:59.999Z")).toISOString()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
    expect(periodEndFor("day", new Date("2026-12-31T12:00:00.000Z")).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });

  /** 2028 is a leap year: Feb 29 exists and Feb 28 must not skip it. */
  it("handles a leap day", () => {
    expect(periodEndFor("day", new Date("2028-02-28T10:00:00.000Z")).toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
    expect(periodEndFor("day", new Date("2028-02-29T10:00:00.000Z")).toISOString()).toBe(
      "2028-03-01T00:00:00.000Z",
    );
  });
});

describe("month windows", () => {
  it("floors to the first of the month in UTC", () => {
    const at = new Date("2026-08-24T13:47:11.512Z");
    expect(periodStartFor("month", at).toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(periodEndFor("month", at).toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  /**
   * The month a fixed 30-day span gets wrong. Adding 30 days to Feb 1 lands in
   * March; incrementing the calendar month does not.
   */
  it("does not drift on a short month", () => {
    expect(periodEndFor("month", new Date("2026-02-01T00:00:00.000Z")).toISOString()).toBe(
      "2026-03-01T00:00:00.000Z",
    );
    expect(periodEndFor("month", new Date("2026-02-28T23:59:59.999Z")).toISOString()).toBe(
      "2026-03-01T00:00:00.000Z",
    );
  });

  it("rolls over the year", () => {
    expect(periodEndFor("month", new Date("2026-12-15T00:00:00.000Z")).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });
});

describe("period keys", () => {
  it("formats a stable, sortable key per window", () => {
    const at = new Date("2026-08-04T13:47:11.512Z");
    expect(periodKeyFor("day", at)).toBe("2026-08-04");
    expect(periodKeyFor("month", at)).toBe("2026-08");
  });

  it("zero-pads so keys sort lexicographically", () => {
    expect(periodKeyFor("day", new Date("2026-01-02T00:00:00.000Z"))).toBe("2026-01-02");
    expect(periodKeyFor("month", new Date("2026-01-02T00:00:00.000Z"))).toBe("2026-01");
  });
});

describe("reset hints", () => {
  it("reports the time remaining in the window", () => {
    const at = new Date("2026-08-24T23:00:00.000Z");
    expect(msUntilReset("day", at)).toBe(60 * 60 * 1000);
  });

  /**
   * Rounding DOWN would tell a client to retry at the exact boundary instant and
   * hand it a second denial, making the header look like a lie.
   */
  it("rounds Retry-After up, never to zero", () => {
    const at = new Date("2026-08-24T23:59:59.500Z");
    expect(retryAfterSecondsFor("day", at)).toBe(1);
    expect(retryAfterSecondsFor("day", new Date("2026-08-24T23:59:59.999Z"))).toBeGreaterThanOrEqual(1);
  });

  it("never returns a negative remaining time", () => {
    expect(msUntilReset("day", new Date("2026-08-24T00:00:00.000Z"))).toBeGreaterThan(0);
  });
});

describe("bounds bundle", () => {
  it("agrees with the individual functions", () => {
    const at = new Date("2026-08-24T13:47:11.512Z");
    for (const window of ["day", "month"] as const) {
      const bounds = periodBoundsFor(window, at);
      expect(bounds.start).toEqual(periodStartFor(window, at));
      expect(bounds.end).toEqual(periodEndFor(window, at));
      expect(bounds.key).toBe(periodKeyFor(window, at));
      expect(bounds.end.getTime()).toBeGreaterThan(bounds.start.getTime());
    }
  });

  it("rejects an invalid date rather than bucketing into NaN", () => {
    expect(() => periodStartFor("day", new Date("nonsense"))).toThrow(RangeError);
  });
});
