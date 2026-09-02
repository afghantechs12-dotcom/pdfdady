export interface WorkflowStep {
  id: string;
  title: string;
  description: string;
  icon: string; // lucide-react icon name — must exist in components/ui/Icon
}

/**
 * The three-step account of what actually happens when someone uses PDFDadi.
 *
 * ## Three steps, not four
 *
 * This was Choose → Run → Keep the result → Pick it up later. The last two both
 * answered "what happens after the job finishes", and splitting them stretched a
 * three-beat story across four columns — so they are merged rather than dropped.
 * Step 3 still carries both halves: download and you are done, or save it to a
 * Workspace and reopen it later with tabs, comments and version history intact.
 * No fact was cut to reach three.
 *
 * ## The wording is conditional on purpose
 *
 * Step 1 says "choose", not "upload": most of the available tools are
 * browser-side, so a blanket "upload your PDF" would describe something that does
 * not happen. Step 2 describes both processing modes and points at the per-tool
 * label that states which one applies, because the site may not claim
 * "everything runs in your browser" — 14 of the available tools are
 * server-processed (docs/launch-feature-evidence.md, R13/R14). Workspace in step
 * 3 is optional: the browser tools need no account at all.
 *
 * ## Short on purpose
 *
 * The descriptions were two-clause sentences sized for a wide three-column row.
 * The visual-fidelity pass grew the step illustrations by a third and paid for
 * the height by cutting these to one line each. Every conditional survived the
 * cut — step 2 still refuses to claim everything runs locally, step 3 still
 * presents the Workspace as the optional branch.
 */
export const workflowSteps: WorkflowStep[] = [
  {
    id: "choose",
    title: "Choose your PDF",
    description:
      "Drop a file in the hero or open a tool directly. No account needed to start.",
    icon: "Upload",
  },
  {
    id: "process",
    title: "Edit or convert it",
    description:
      "Every tool says where it runs — your browser, or our servers when the job needs more.",
    icon: "Wand2",
  },
  {
    id: "keep",
    title: "Download, save or continue",
    description:
      "Download and you are done. Or save it to a Workspace, with comments and version history kept.",
    icon: "Download",
  },
];
