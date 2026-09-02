import type { ReactNode } from "react";

interface JsonLdProps {
  /**
   * One schema object, an array of them, or null (each gets its own script tag).
   * Accepts plain values or unresolved promises so callers can hand the result
   * of an async schema builder directly without an extra `await`.
   */
  data:
    | Record<string, unknown>
    | null
    | Promise<Record<string, unknown> | null>
    | Array<Record<string, unknown> | null | Promise<Record<string, unknown> | null>>;
}

/**
 * Renders schema.org JSON-LD as <script type="application/ld+json">. Server
 * component — the JSON is emitted in the initial HTML so crawlers read it
 * without executing JS. Awaits any promises in `data` before serializing.
 *
 * We serialize with a replacer that escapes "<" to prevent breaking out of the
 * script tag; this is the standard safe pattern for inline JSON-LD.
 */
export async function JsonLd({ data }: JsonLdProps): Promise<ReactNode> {
  const items = (Array.isArray(data) ? data : [data]);
  const resolved = await Promise.all(
    items.map(async (d) => (d ? await d : null)),
  );
  const filtered = resolved.filter(
    (d): d is Record<string, unknown> => Boolean(d),
  );

  return (
    <>
      {filtered.map((item, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serialize(item) }}
        />
      ))}
    </>
  );
}

function serialize(obj: Record<string, unknown>): string {
  return JSON.stringify(obj).replace(/</g, "\\u003c");
}
