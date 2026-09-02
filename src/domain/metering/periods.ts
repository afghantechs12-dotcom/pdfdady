import type { MeterWindow } from "./meters";

/**
 * WHEN a meter's allowance resets.
 *
 * Every function here takes the current instant as an argument. None of them
 * calls `Date.now()`. That is the whole reason this file exists as a separate
 * pure module: a period boundary is exactly the kind of logic that is wrong at
 * 23:59 UTC on the last day of a month, and a function that reads the clock
 * itself cannot be tested at that instant.
 *
 * UTC, not local time. A day boundary that follows the server's timezone means
 * the same user's allowance resets at a different wall-clock moment depending on
 * which region served the request, and a deploy that moves regions silently
 * grants or steals a day. UTC is the same everywhere, and the snapshot endpoint
 * reports the reset instant explicitly so a UI can render it in local time.
 */

/** The inclusive start of the window containing `at`. */
export function periodStartFor(window: MeterWindow, at: Date): Date {
  const ms = at.getTime();
  if (!Number.isFinite(ms)) {
    throw new RangeError("periodStartFor requires a valid Date.");
  }
  if (window === "day") {
    return new Date(
      Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), 0, 0, 0, 0),
    );
  }
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1, 0, 0, 0, 0));
}

/**
 * The exclusive end of the window containing `at` — i.e. the next window's
 * start, which is also the instant the allowance resets.
 *
 * Computed by incrementing the calendar field and letting `Date.UTC` normalize,
 * rather than by adding 24h or 30 days. Adding a fixed span is what produces a
 * "monthly" window that drifts a day every February.
 */
export function periodEndFor(window: MeterWindow, at: Date): Date {
  const start = periodStartFor(window, at);
  if (window === "day") {
    return new Date(
      Date.UTC(
        start.getUTCFullYear(),
        start.getUTCMonth(),
        start.getUTCDate() + 1,
        0,
        0,
        0,
        0,
      ),
    );
  }
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

/**
 * A stable, human-readable key for the window: `2026-08-24` or `2026-08`.
 *
 * Used for log context and the admin surface. The counters table keys on the
 * `periodStart` Date rather than this string — a date column sorts and range-
 * scans, a formatted string does neither reliably across providers.
 */
export function periodKeyFor(window: MeterWindow, at: Date): string {
  const start = periodStartFor(window, at);
  const y = String(start.getUTCFullYear()).padStart(4, "0");
  const m = String(start.getUTCMonth() + 1).padStart(2, "0");
  if (window === "month") return `${y}-${m}`;
  const d = String(start.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export interface PeriodBounds {
  window: MeterWindow;
  key: string;
  start: Date;
  /** Exclusive. Also the instant this window's allowance resets. */
  end: Date;
}

/** Both bounds plus the key, so callers do not recompute the start three times. */
export function periodBoundsFor(window: MeterWindow, at: Date): PeriodBounds {
  return {
    window,
    key: periodKeyFor(window, at),
    start: periodStartFor(window, at),
    end: periodEndFor(window, at),
  };
}

/** Milliseconds until this window resets. Never negative. */
export function msUntilReset(window: MeterWindow, at: Date): number {
  return Math.max(0, periodEndFor(window, at).getTime() - at.getTime());
}

/**
 * `Retry-After` seconds for a denial caused by an exhausted meter.
 *
 * Rounded UP: rounding down would tell a client to retry at the instant the
 * boundary is still being evaluated, producing a second denial and a client
 * that believes the header lied to it.
 */
export function retryAfterSecondsFor(window: MeterWindow, at: Date): number {
  return Math.max(1, Math.ceil(msUntilReset(window, at) / 1000));
}
