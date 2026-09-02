export interface Feature {
  id: string;
  title: string;
  description: string;
  icon: string; // lucide-react icon name
}

/**
 * The productivity section — what having somewhere to keep a document buys you.
 *
 * Every entry is a capability verified in the repository and recorded in
 * docs/launch-feature-evidence.md. Four earlier claims (C1-C3, C7 in that
 * document) were removed outright because they were false or unevidenceable:
 * an absolute security guarantee; a promise that files are only ever processed
 * locally, which 14 server-side tools contradict; a promise that no file is
 * retained, which durable Workspace storage contradicts; and an unqualified
 * speed guarantee that depends on file size and tool.
 *
 * The replacement copy went further than removal: rather than a generic "why
 * choose us" row, these are the four features a visitor cannot get from a
 * single-shot converter. Where processing happens is stated per tool, derived
 * from the tool registry via lib/tools/processingMode.ts — never asserted
 * globally in marketing copy.
 *
 * Kept distinct from data/productHighlights.ts, which covers the Workspace and
 * editor themselves; this file covers what happens to work over time.
 *
 * The exact removed strings are listed in FORBIDDEN_CLAIMS and enforced by a
 * scan in lib/tools/processingMode.test.ts, so they cannot quietly return.
 */
export const features: Feature[] = [
  {
    id: "versions",
    title: "Version history",
    description:
      // Scoped to the path that actually publishes a version: saving from the
      // editor into a Workspace. The Workspace document surface autosaves
      // drafts and does not publish versions, so an unqualified "every save"
      // claimed a capability one of the two surfaces does not have.
      "Saving a document from the editor into your Workspace keeps the version before it, so you can inspect an earlier one or restore it.",
    icon: "History",
  },
  {
    id: "autosave",
    title: "Autosave and recovery",
    description:
      "Changes are saved as you work. If the tab closes unexpectedly, you are offered the unsaved work back.",
    icon: "Save",
  },
  {
    id: "comments",
    title: "Comments and outline",
    description:
      "Threaded comments you can resolve, and an outline for finding your way around a long document.",
    icon: "MessageSquare",
  },
  {
    id: "operations",
    title: "Jobs you can watch",
    description:
      // "or retried" was true of one tool: retry is implemented in
      // PipelineToolRunner, which serves compress-pdf only, and only when the
      // unified-pipeline flag is on. Progress and cancel are true of all 14
      // server tools, so that is what the claim says.
      "Server-side work reports progress while it runs and can be cancelled, instead of leaving you guessing.",
    icon: "Clock",
  },
];
