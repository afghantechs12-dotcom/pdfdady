"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { UseEditorResult } from "@/hooks/editor/useEditor";

/**
 * Shares a single bound editor instance ({@link UseEditorResult}) across the
 * workspace tree — canvas, toolbar, and panels all consume the same service +
 * state + actions without prop-drilling. The {@link EditorWorkspace} creates the
 * editor via `useEditor` and provides it here; descendants read it via
 * {@link useEditorContext}.
 */

/**
 * Exported so a control can read the editor OPTIONALLY — see
 * `useDocumentColors`. `useEditorContext` throws outside a provider, which is
 * the right default for anything that needs the editor to function, but wrong
 * for an enhancement (the document's colour palette) that should simply be
 * absent in a preview or a standalone tool.
 */
export const EditorContext = createContext<UseEditorResult | null>(null);

export function EditorProvider({ editor, children }: { editor: UseEditorResult; children: ReactNode }) {
  return <EditorContext.Provider value={editor}>{children}</EditorContext.Provider>;
}

/** Reads the shared editor binding; throws if used outside an EditorProvider. */
export function useEditorContext(): UseEditorResult {
  const editor = useContext(EditorContext);
  if (!editor) {
    throw new Error("useEditorContext must be used within an EditorProvider.");
  }
  return editor;
}
