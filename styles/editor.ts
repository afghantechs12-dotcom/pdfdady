/**
 * PDFDadi premium editor shell tokens (editor premium redesign).
 *
 * The editor surfaces (toolbar, left rail, canvas application, right inspector,
 * status bar, floating controls) are a productivity surface: cooler and flatter
 * than the marketing palette, but with an indigo/purple accent carried through
 * from the brand. These values are mirrored into tailwind.config.ts as the
 * `editor-*` utility namespace (e.g. `bg-editor-bg`, `border-editor-border`,
 * `text-editor-muted`, `shadow-editor-floating`), exactly like `styles/tokens.ts`
 * feeds the `app-*` namespace.
 *
 * Rule of the shell: the canvas stays dominant and centered. Side panels exist
 * only while the measured width affords them (see `editorPanelLayout`), and every
 * surface uses `min-w-0`/`min-h-0` + explicit overflow containment so no panel
 * can grow a horizontal scrollbar of its own.
 */

export const editorColors = {
  /** Cool light application background behind the canvas. */
  bg: "#F4F6FB",
  /** White surfaces: toolbar, rail, inspector, status bar, drawers. */
  surface: "#FFFFFF",
  /** Hover/inset surface for rows and secondary chrome. */
  subtle: "#F8FAFC",
  /** Subtle borders and dividers. */
  border: "#E6E9F2",
  /** Stronger divider for panel edges against the app background. */
  borderstrong: "#D8DEE9",
  /** Primary shell text. */
  text: "#1F2430",
  /** Secondary shell text (labels, captions, readouts). */
  muted: "#667085",
  /** Indigo/purple accent — the brand primary carried into the shell. */
  accent: "#7C3AED",
  accenthover: "#6D28D9",
  /** Light accent surface for active tool / selected row treatment. */
  accentsoft: "#F3EEFF",
  /** The PDF page surface rendered on the canvas. */
  page: "#FFFFFF",

  /*
   * ── Three DISTINCT signal colours ──────────────────────────────────────────
   *
   * `accent` above (purple) means "brand, and the tool you have chosen".
   * The two below must NOT be that purple. When brand chrome, the selection
   * outline, the active tool and the alignment guides are all one hue, the
   * canvas stops being readable: a selected object's outline is
   * indistinguishable from a snap guide passing through it, and neither is
   * distinguishable from brand furniture. Each signal gets its own hue so that
   * "what is selected", "what am I snapping to" and "what tool is armed" are
   * three separate questions with three separate answers.
   */

  /**
   * SELECTION — object outlines, handles, and the selected-swatch ring. A
   * saturated blue: maximally separated from both the purple chrome and the pink
   * guides, and it reads as "system UI, not document content" over any artwork.
   */
  selection: "#2563EB",
  selectionsoft: "#DBEAFE",
  /** The white halo drawn under selection strokes so they survive dark artwork. */
  selectionhalo: "rgba(255,255,255,0.92)",

  /**
   * GUIDES — alignment/snap indicators and equal-spacing marks. Magenta: it must
   * be legible ON TOP of a selected object, so it cannot share the selection hue.
   */
  guide: "#DB2777",
} as const;

/**
 * The container-width threshold below which the editor uses the floating
 * bottom control capsule instead of the status bar's page/zoom readouts.
 * Deliberately NOT a Tailwind viewport breakpoint: in the workbench the editor
 * sits beside the AppShell sidebar, so a 1024px window does not give the editor
 * 1024px. The workspace measures its own container (`useEditorPanels` measures
 * the window; the frame measures the real container).
 */
export const editorBreakpoints = {
  /** Below this container width, show FloatingCanvasControls + compact status bar. */
  floatingControls: 1024,
} as const;

export const editorShadow = {
  /** The PDF page on the canvas. */
  page: "0 2px 8px rgba(16, 24, 40, 0.10), 0 8px 24px rgba(16, 24, 40, 0.08)",
  /** Floating bottom capsule / mini surfaces over the canvas. */
  floating: "0 8px 24px rgba(16, 24, 40, 0.14)",
} as const;
