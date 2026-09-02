"use client";

import { useCallback, useMemo, useRef } from "react";
import type { AnalyticsEventName } from "@/src/domain/metering/events";

/**
 * Non-blocking client analytics. Fire-and-forget, by construction.
 *
 * Every design decision here answers the same requirement: a local PDF tool must
 * never be affected by analytics. Merge PDF runs entirely in the tab — nothing it
 * does needs the network — so an ingest that is slow, blocked, or 500ing must be
 * invisible to it.
 *
 *  - `track` returns `void`, not a promise. There is nothing to await, so no call
 *    site can accidentally put a beacon in front of a merge or a download.
 *  - Every send is inside a `try`, and the `fetch` has a `.catch`. An adblocker
 *    that refuses the request produces a rejected promise, and an unhandled one
 *    is a console error on a page where nothing is wrong.
 *  - `keepalive` lets a beacon outlive the page, which is the only way `download`
 *    survives a navigation started in the same tick.
 *
 * ## Duplicate suppression, and why it is per-key rather than per-event
 *
 * React runs effects twice in development Strict Mode, `useEffect` re-runs when
 * dependencies change, and a user clicks a merge button twice. All three produce
 * the same event twice, and the funnel then reports more views than visitors.
 *
 * `trackOnce` dedupes on a caller-supplied key held in a ref, so it survives
 * re-renders without a state update. The key is per-*occurrence*, not per event
 * name: `file_selected` for two files then three files is two real signals, while
 * `tool_view` for one tool is one signal however many times the effect runs. A
 * blanket per-name guard would silently collapse the first case.
 *
 * ## What it will not send
 *
 * `properties` is typed as primitives only, and the server drops any key the
 * taxonomy has not declared for the event. Both matter: the type stops a
 * `{ file }` object being written here, and the allowlist stops a declared-key
 * leak reaching a store. Do not pass a filename, a page count from document
 * content, or anything read out of the PDF — `src/domain/metering/events.ts` is
 * the list of what is allowed, and it is enforced server-side.
 *
 * No identity is sent, ever. The funnel is stitched server-side from the
 * HttpOnly cookie via a rotating keyed hash; this hook has no id to leak, which
 * is why there is no `identify` here.
 */

export type AnalyticsPropertyValue = string | number | boolean;
export type ClientAnalyticsProperties = Record<string, AnalyticsPropertyValue>;

export const ANALYTICS_ENDPOINT = "/api/analytics/events";

interface QueuedEvent {
  name: AnalyticsEventName;
  properties?: ClientAnalyticsProperties;
  at: number;
}

/**
 * Fires one batch. Module-level rather than a hook member so a beacon sent from
 * an unmounting component does not depend on that component still being alive.
 */
function send(events: QueuedEvent[]): void {
  if (events.length === 0 || typeof window === "undefined") return;
  const body = JSON.stringify({ events });
  try {
    void fetch(ANALYTICS_ENDPOINT, {
      method: "POST",
      // `keepalive` is what makes an unload-time beacon land. Without it the
      // browser cancels an in-flight request when the page goes away, which is
      // exactly when `download` fires.
      keepalive: true,
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body,
    }).catch(() => {
      // Offline, blocked by an extension, server down. All fine — analytics is
      // not a feature the user asked for.
    });
  } catch {
    // `fetch` itself throwing (a hostile polyfill, a locked-down environment).
  }
}

export interface UseAnalyticsOptions {
  /**
   * Attached to every event from this hook. Use for the dimensions that are
   * constant for a surface — `toolSlug`, `executionMode`, `surface`.
   *
   * Read through a ref internally, so passing an inline object does not change
   * the identity of `track` and does not re-run an effect that depends on it.
   */
  context?: ClientAnalyticsProperties;
}

export interface UseAnalytics {
  /** Sends one event. Returns immediately; never throws, never blocks. */
  track: (name: AnalyticsEventName, properties?: ClientAnalyticsProperties) => void;
  /** Sends one event at most once per `key` for the lifetime of this hook. */
  trackOnce: (
    key: string,
    name: AnalyticsEventName,
    properties?: ClientAnalyticsProperties,
  ) => void;
}

export function useAnalytics(options: UseAnalyticsOptions = {}): UseAnalytics {
  const sentKeys = useRef<Set<string>>(new Set());
  // Held in a ref so an inline `context` object cannot change `track`'s identity
  // — a `track` that changes every render would re-fire every effect keyed on it,
  // which is the duplicate-event storm this hook exists to avoid.
  const contextRef = useRef(options.context);
  contextRef.current = options.context;

  const track = useCallback(
    (name: AnalyticsEventName, properties?: ClientAnalyticsProperties) => {
      send([
        {
          name,
          properties: { ...contextRef.current, ...properties },
          at: Date.now(),
        },
      ]);
    },
    [],
  );

  const trackOnce = useCallback(
    (key: string, name: AnalyticsEventName, properties?: ClientAnalyticsProperties) => {
      if (sentKeys.current.has(key)) return;
      sentKeys.current.add(key);
      track(name, properties);
    },
    [track],
  );

  return useMemo(() => ({ track, trackOnce }), [track, trackOnce]);
}
