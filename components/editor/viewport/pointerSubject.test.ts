import { describe, expect, it, vi } from "vitest";
import { createPointerSubject } from "./pointerSubject";

describe("createPointerSubject", () => {
  it("delivers published values to subscribers and tracks the latest", () => {
    const subject = createPointerSubject();
    const seen: Array<{ x: number; y: number } | null> = [];
    subject.subscribe((p) => seen.push(p));

    expect(subject.get()).toBeNull();
    subject.publish({ x: 1, y: 2 });
    subject.publish(null);
    subject.publish({ x: 3, y: 4 });

    expect(seen).toEqual([{ x: 1, y: 2 }, null, { x: 3, y: 4 }]);
    expect(subject.get()).toEqual({ x: 3, y: 4 });
  });

  it("stops delivering after unsubscribe", () => {
    const subject = createPointerSubject();
    const listener = vi.fn();
    const unsubscribe = subject.subscribe(listener);
    subject.publish({ x: 1, y: 1 });
    unsubscribe();
    subject.publish({ x: 2, y: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    // The latest value is still readable without a subscription.
    expect(subject.get()).toEqual({ x: 2, y: 2 });
  });

  it("supports multiple independent subscribers", () => {
    const subject = createPointerSubject();
    const a = vi.fn();
    const b = vi.fn();
    subject.subscribe(a);
    const offB = subject.subscribe(b);
    subject.publish(null);
    offB();
    subject.publish({ x: 9, y: 9 });
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
