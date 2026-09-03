import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { JsonLd } from "./JsonLd";

/**
 * R13 — HTML-like content cannot break out of the one raw-HTML sink we have.
 *
 * `JsonLd` is the single `dangerouslySetInnerHTML` in the product. Everything
 * else renders through React text nodes, which escape on their own; this one
 * writes a string straight into the document, so the `<` escape in `serialize`
 * is load-bearing. It had no test: deleting the `.replace()` stayed green, and
 * a CMS-authored title containing `</script>` would then close the script tag
 * and execute whatever followed — from a page a crawler and every visitor load.
 */
async function emitted(data: Record<string, unknown>): Promise<string[]> {
  const tree = (await JsonLd({ data })) as ReactElement<{ children: ReactElement<{
    dangerouslySetInnerHTML: { __html: string };
  }>[] }>;
  return tree.props.children.map((c) => c.props.dangerouslySetInnerHTML.__html);
}

describe("JsonLd raw-HTML sink", () => {
  it("escapes < so a value cannot close the script tag", async () => {
    const [html] = await emitted({
      "@type": "Article",
      headline: '</script><img src=x onerror="alert(1)">',
    });

    expect(html).not.toContain("</script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("\\u003c/script>");
  });

  it("still produces JSON a crawler can parse", async () => {
    const [html] = await emitted({ "@type": "WebSite", name: "PDF<Dadi>" });

    expect(JSON.parse(html)).toEqual({ "@type": "WebSite", name: "PDF<Dadi>" });
  });

  it("escapes every item when several schemas are rendered", async () => {
    const all = await emitted([
      { a: "<script>" },
      { b: "<iframe>" },
    ] as unknown as Record<string, unknown>);

    expect(all).toHaveLength(2);
    for (const html of all) expect(html).not.toContain("<");
  });
});
