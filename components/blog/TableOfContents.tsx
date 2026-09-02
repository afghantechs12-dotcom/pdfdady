import type { BlogPost, ContentBlock } from "@/data/blog";

/**
 * Sticky in-article table of contents built from the h2 heading blocks. Anchors
 * to the same ids ArticleBody renders. Rendered as a semantic <nav>.
 */
export function TableOfContents({ blocks }: { blocks: ContentBlock[] }) {
  const headings = blocks.filter(
    (b): b is Extract<ContentBlock, { type: "heading" }> =>
      b.type === "heading" && b.level === 2,
  );
  if (headings.length < 3) return null;

  return (
    <nav
      aria-label="Table of contents"
      className="rounded-2xl border border-softborder bg-lavender/40 p-5"
    >
      <p className="text-xs font-semibold uppercase tracking-wider text-primary">
        On this page
      </p>
      <ul className="mt-3 space-y-2.5">
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              className="block text-sm leading-snug text-navy-soft transition-colors hover:text-primary"
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function hasToc(post: BlogPost): boolean {
  return (
    post.body.filter((b) => b.type === "heading" && b.level === 2).length >= 3
  );
}
