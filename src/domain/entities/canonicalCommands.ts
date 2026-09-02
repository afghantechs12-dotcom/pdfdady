import type { CommandDescriptor } from "./CommandPalette";

/**
 * The canonical M7 command set.
 *
 * One definition per command, registered once at container creation, so the
 * palette, a keyboard shortcut and a menu entry all read the same descriptor.
 * The alternative — each page registering its own set — produces a palette whose
 * contents depend on which screen opened it, and a shortcut that means different
 * things in different places.
 *
 * Every entry here maps to a feature that exists and to an action the client can
 * actually carry out. No placeholders: a command that opens nothing is worse
 * than a missing one, because a user who found it in the palette reasonably
 * concludes the feature is broken rather than absent.
 *
 * `requirements` drives display only. `CommandPaletteService.execute`
 * re-authorizes against the Workspace regardless of what was shown, so nothing
 * here grants anything.
 */
export const CANONICAL_COMMANDS: readonly CommandDescriptor[] = [
  // ---- document (M7.5, M7.6) ------------------------------------------------
  {
    id: "doc.save",
    label: "Save document",
    keywords: ["save", "commit", "version", "store"],
    category: "document",
    shortcut: "Ctrl+S",
    requirements: { document: true, write: true },
  },
  {
    id: "doc.saveAs",
    label: "Save as new version",
    keywords: ["save as", "duplicate", "snapshot", "version"],
    category: "document",
    shortcut: "Ctrl+Shift+S",
    requirements: { document: true, write: true },
  },
  {
    id: "doc.properties",
    label: "Document properties",
    keywords: ["metadata", "properties", "title", "author", "info"],
    category: "document",
    requirements: { document: true },
  },
  {
    id: "doc.statistics",
    label: "Document statistics",
    keywords: ["statistics", "counts", "pages", "words", "analyse"],
    category: "document",
    requirements: { document: true },
  },
  {
    id: "doc.versions",
    label: "Version history",
    keywords: ["versions", "history", "restore", "revisions"],
    category: "document",
    requirements: { document: true },
  },
  {
    id: "doc.compare",
    label: "Compare versions",
    keywords: ["compare", "diff", "differences", "changes"],
    category: "document",
    requirements: { document: true },
  },

  // ---- collaboration (M7.10) -----------------------------------------------
  {
    id: "doc.comments",
    label: "Comments",
    keywords: ["comments", "discussion", "threads", "review", "notes"],
    category: "collaboration",
    requirements: { document: true },
  },
  {
    id: "doc.share",
    label: "Share document",
    keywords: ["share", "permissions", "grant", "access", "invite"],
    category: "collaboration",
    requirements: { document: true, write: true },
  },

  // ---- view (M7.13) --------------------------------------------------------
  {
    id: "view.split",
    label: "Split view",
    keywords: ["split", "two panes", "side by side", "compare view"],
    category: "view",
    requirements: { document: true },
  },
  {
    id: "view.single",
    label: "Single pane view",
    keywords: ["single", "close split", "one pane", "unsplit"],
    category: "view",
    requirements: { split: true },
  },
  {
    id: "pane.focusLeft",
    label: "Focus left pane",
    keywords: ["left pane", "focus", "switch pane"],
    category: "view",
    shortcut: "Alt+Left",
    requirements: { split: true },
  },
  {
    id: "pane.focusRight",
    label: "Focus right pane",
    keywords: ["right pane", "focus", "switch pane"],
    category: "view",
    shortcut: "Alt+Right",
    requirements: { split: true },
  },

  // ---- navigation (M7.13) --------------------------------------------------
  {
    id: "nav.back",
    label: "Go back",
    keywords: ["back", "previous", "history"],
    category: "navigation",
    requirements: { document: true },
  },
  {
    id: "nav.forward",
    label: "Go forward",
    keywords: ["forward", "next", "history"],
    category: "navigation",
    requirements: { document: true },
  },
  {
    id: "nav.goToPage",
    label: "Go to page",
    keywords: ["page", "jump", "goto", "navigate"],
    category: "navigation",
    requirements: { document: true },
  },

  // ---- workspace (M7.3, M7.4, M7.8) ----------------------------------------
  {
    id: "doc.search",
    label: "Search documents",
    keywords: ["search", "find", "full text", "query"],
    category: "workspace",
    shortcut: "Ctrl+Shift+F",
  },
  {
    id: "workspace.upload",
    label: "Upload document",
    keywords: ["upload", "import", "add file", "new document"],
    category: "workspace",
    requirements: { write: true },
  },
  {
    id: "workspace.fileManager",
    label: "Open file manager",
    keywords: ["files", "browse", "folders", "manager"],
    category: "workspace",
  },
  {
    id: "workspace.tags",
    label: "Manage tags",
    keywords: ["tags", "labels", "collections", "organise"],
    category: "workspace",
  },
  {
    id: "workspace.operations",
    label: "Show operation center",
    keywords: ["operations", "progress", "jobs", "activity", "tasks"],
    category: "workspace",
  },
  {
    id: "workspace.commandPalette",
    label: "Show all commands",
    keywords: ["commands", "palette", "help", "shortcuts"],
    category: "workspace",
    shortcut: "Ctrl+K",
  },
] as const;
