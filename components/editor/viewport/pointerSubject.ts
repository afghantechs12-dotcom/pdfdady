import type { Point } from "@/src/domain/editor/geometry";

/**
 * Tiny mutable subjects for high-frequency canvas → status-bar values (M6).
 * The canvas publishes; only the small status-bar readout subscribes — so the
 * update re-renders one leaf component instead of the whole workspace tree.
 * Pure TS (no React), so it is unit-testable in Node.
 */
export interface ValueSubject<T> {
  /** Subscribes to updates; returns the unsubscribe function. */
  subscribe(listener: (value: T) => void): () => void;
  /** Publishes the latest value to every subscriber. */
  publish(value: T): void;
  /** The most recently published value. */
  get(): T;
}

/** Creates an independent subject seeded with `initial`. */
export function createValueSubject<T>(initial: T): ValueSubject<T> {
  const listeners = new Set<(value: T) => void>();
  let value = initial;
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(next) {
      value = next;
      for (const listener of listeners) listener(next);
    },
    get() {
      return value;
    },
  };
}

/**
 * Live pointer coordinates for the status bar. The canvas publishes
 * rAF-throttled page-space coordinates (null = outside the canvas).
 */
export type PointerSubject = ValueSubject<Point | null>;

/** Creates an independent pointer subject (one per workspace). */
export function createPointerSubject(): PointerSubject {
  return createValueSubject<Point | null>(null);
}
