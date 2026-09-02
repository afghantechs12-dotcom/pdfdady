export interface ProductHighlight {
  id: string;
  title: string;
  description: string;
  icon: string; // lucide-react icon name — must exist in components/ui/Icon
  /** The evidence-matrix row this claim is traceable to. */
  evidence: string;
}

/**
 * The Workspace + Editor differentiator, as shown on the homepage.
 *
 * These are the capabilities that make PDFDadi a place documents live rather
 * than a grid of one-shot converters — §2 of docs/launch-feature-evidence.md,
 * none of which appeared anywhere on the public site while eight unbuilt AI
 * tools had a full-width section to themselves.
 *
 * The *productivity* claims that follow from having somewhere to keep a
 * document — version history, autosave, comments, operations — live in
 * data/features.ts and render further down the page, so the two sections do
 * not restate each other.
 *
 * `evidence` is not rendered. It exists so a reviewer can check each line
 * against the matrix without leaving the file, and so a test can assert every
 * entry cites a row.
 *
 * ## Why the descriptions are one line each
 *
 * They were two-to-three-sentence paragraphs, written when this section had a
 * half-page column to fill. The visual-fidelity pass narrowed the copy column to
 * ~38% so the product preview beside it could be the section's subject, and four
 * paragraphs in that column made the flagship showcase read as an article. Each
 * description was cut to the shortest form that still states the same claim —
 * nothing was traded away, and every `evidence` row is unchanged.
 */
export const productHighlights: ProductHighlight[] = [
  {
    id: "organize",
    title: "Folders, tags and projects",
    description: "Organised how you want, and findable by full-text search.",
    icon: "FolderKanban",
    evidence: "R1",
  },
  {
    id: "editor",
    title: "A genuine PDF editor",
    description: "Text, images, shapes, signatures, pages. No desktop install.",
    icon: "PenLine",
    evidence: "R2",
  },
  {
    id: "tabs",
    title: "Tabs and split view",
    description: "Several documents open at once, two of them side by side.",
    icon: "Columns2",
    evidence: "R5",
  },
  {
    id: "continuity",
    title: "Sessions that survive the tab closing",
    description: "Reopens tomorrow with the documents, tabs and layout you left.",
    icon: "History",
    evidence: "R4, R5",
  },
];
