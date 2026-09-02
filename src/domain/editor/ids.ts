/**
 * Stable id generation for editor objects, layers, pages, and documents.
 *
 * The default uses `crypto.randomUUID()` (available in Node 19+ and all modern
 * browsers) with a counter-based fallback for the rare runtime without it. Tests
 * that need deterministic ids swap the factory via {@link setIdFactory} (and
 * restore it in `afterEach`); production code never touches the factory.
 */

let factory: () => string = defaultFactory;
let counter = 0;

function defaultFactory(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  // Fallback: timestamp + monotonic counter + Math.random — not cryptographically
  // strong, but unique enough for editor object ids in a single session.
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Overrides the id factory (for tests). Returns a function to restore the default. */
export function setIdFactory(next: () => string): () => void {
  const previous = factory;
  factory = next;
  return () => {
    factory = previous;
  };
}

/** Generates a new unique id, optionally prefixed (e.g. "obj", "layer"). */
export function generateId(prefix?: string): string {
  const id = factory();
  return prefix ? `${prefix}-${id}` : id;
}
