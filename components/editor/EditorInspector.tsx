"use client";

import { useId, useRef } from "react";
import { FileText, History, List, MessageSquare, PanelRightClose } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { PropertiesPanel } from "@/components/editor/panels/PropertiesPanel";
import { inspectorTabPresentation } from "@/components/editor/editorPanelLayout";
import type { InspectorTabId } from "@/components/editor/editorPanelLayout";

/**
 * The editor's single right-hand Inspector.
 *
 * One dock, one tab strip. `Properties` describes the current SELECTION and is
 * rendered here; `Outline`/`Comments`/`Versions` describe the DOCUMENT and are
 * rendered by the workspace inspector passed in as `documentPanel`, which owns
 * its own data loading. This component only decides which of the two bodies is
 * on screen — it deliberately knows nothing about comment threads or versions,
 * so the workspace keeps a single implementation of each.
 *
 * The strip is flat rather than a Properties/Document split with the document's
 * tabs nested inside: nested strips cost two clicks and a mental model to reach
 * "Comments", and the flat strip is what makes one dock read as one panel.
 *
 * Tab semantics follow the WAI-ARIA tabs pattern, matching the left rail's
 * strip: roving `tabIndex`, arrow/Home/End keys, `aria-selected` on the tab and
 * `aria-labelledby` on the panel.
 */
export interface EditorInspectorProps {
  tabs: readonly InspectorTabId[];
  activeTab: InspectorTabId;
  onSelectTab: (tab: InspectorTabId) => void;
  /**
   * The workspace document inspector body, already scoped to the active tab.
   * Absent in the standalone editor, which is why `tabs` may hold one entry.
   */
  documentPanel?: React.ReactNode;
  /** Collapses the dock. Omitted where collapsing is not offered (drawers). */
  onCollapse?: () => void;
}

const TAB_META: Record<InspectorTabId, { label: string; icon: typeof List }> = {
  properties: { label: "Properties", icon: FileText },
  outline: { label: "Outline", icon: List },
  comments: { label: "Comments", icon: MessageSquare },
  versions: { label: "Versions", icon: History },
};

export function EditorInspector({
  tabs,
  activeTab,
  onSelectTab,
  documentPanel,
  onCollapse,
}: EditorInspectorProps) {
  const baseId = useId();
  const tabRefs = useRef(new Map<InspectorTabId, HTMLButtonElement>());
  const presentation = inspectorTabPresentation(tabs.length);
  const showIcon = presentation !== "label-only";
  const showLabel = presentation !== "icon-only";

  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = tabs.indexOf(activeTab);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target = tabs[next];
    onSelectTab(target);
    tabRefs.current.get(target)?.focus();
  };

  return (
    /**
     * `w-full min-w-0` is load-bearing, not defensive tidiness. This div is the
     * only flex item of the `w-[320px]` dock, and a flex item's automatic minimum
     * size is its MIN-CONTENT width — so without it the whole Inspector refused to
     * shrink below the widest thing inside it and spilled out of the dock: measured
     * `clientWidth 319, scrollWidth 357`, which pushed the tab strip and the
     * Rotate / Duplicate / Delete row 38px past the dock and clipped "Delete"
     * against the window edge. Every descendant here already carries `min-w-0`;
     * all of those guards were defeated at this first hop.
     */
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-editor-surface">
      {/* `sticky top-0` + `z-10` keeps the strip visible while a long Properties
          body scrolls (H29). The strip is OUTSIDE the scroll container, so this
          is belt-and-braces for the drawer layout, where the whole dock scrolls.
          An opaque background is required — a translucent strip would let panel
          content show through as it passes beneath. */}
      <div className="sticky top-0 z-10 flex shrink-0 items-stretch border-b border-editor-border bg-editor-surface">
        <div
          role="tablist"
          aria-label="Inspector"
          onKeyDown={onKeyDown}
          className="flex min-w-0 flex-1"
        >
          {tabs.map((tab) => {
            const { label, icon: Icon } = TAB_META[tab];
            const selected = tab === activeTab;
            return (
              <button
                key={tab}
                ref={(el) => {
                  if (el) tabRefs.current.set(tab, el);
                  else tabRefs.current.delete(tab);
                }}
                type="button"
                role="tab"
                id={`${baseId}-tab-${tab}`}
                aria-selected={selected}
                aria-controls={`${baseId}-panel-${tab}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => onSelectTab(tab)}
                title={label}
                aria-label={label}
                className={cn(
                  // `-mb-px` pulls the 2px indicator over the container's 1px
                  // border so the active tab reads as connected to its panel
                  // rather than as a floating underline.
                  //
                  // No `min-w-0` and no `truncate` on this button: the automatic
                  // minimum size IS the fit guarantee. A tab that cannot shrink
                  // below its own content can never render its label as an
                  // ellipsis, and `inspectorTabPresentation` has already chosen a
                  // presentation whose combined min-content fits the 288px strip.
                  //
                  // `h-10` rather than `py-2.5` (P5). The padding version derived
                  // its height from an 11px font's line box and measured
                  // **38.5px**, against the left rail's 40px tab at 12px — two tab
                  // strips in one chrome, 1.5px apart, one of them on a fractional
                  // height. The height is now declared, so it no longer depends on
                  // the type scale; the 11px type itself stays, because
                  // `INSPECTOR_TAB_COST` is measured at that scale and 12px would
                  // push four tabs past the strip and force icon-only.
                  "flex h-10 flex-1 basis-0 items-center justify-center gap-1.5 -mb-px border-b-2 px-1.5 text-[11px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-editor-accent/40",
                  selected
                    ? "border-editor-accent bg-editor-accentsoft/40 text-editor-accent"
                    : "border-transparent text-editor-muted hover:bg-editor-subtle hover:text-editor-text",
                )}
              >
                {showIcon ? <Icon size={14} aria-hidden="true" className="shrink-0" /> : null}
                {/* `whitespace-nowrap` rather than `truncate`: the word either
                    renders in full or the strip has already dropped to an
                    icon-only presentation. There is no in-between state where a
                    tab shows a fragment of its own name. */}
                {showLabel ? <span className="whitespace-nowrap">{label}</span> : null}
              </button>
            );
          })}
        </div>
        {onCollapse ? (
          <button
            type="button"
            onClick={onCollapse}
            title="Collapse inspector"
            aria-label="Collapse inspector"
            className="flex shrink-0 items-center border-l border-editor-border px-2 text-editor-muted transition-colors hover:bg-editor-subtle hover:text-editor-text focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-editor-accent/40"
          >
            <PanelRightClose size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div
        role="tabpanel"
        id={`${baseId}-panel-${activeTab}`}
        aria-labelledby={`${baseId}-tab-${activeTab}`}
        // `min-w-0` guards against an unbreakable value (a PDF subset font name)
        // setting a horizontal-scroll floor for the whole dock.
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        {activeTab === "properties" ? <PropertiesPanel /> : documentPanel}
      </div>
    </div>
  );
}
