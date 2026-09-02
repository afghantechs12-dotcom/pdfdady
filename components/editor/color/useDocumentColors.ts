"use client";

import { useContext, useMemo } from "react";
import { EditorContext } from "@/components/editor/EditorContext";
import type { EditorColor } from "@/src/domain/editor/objects";
import { collectDocumentColors } from "./documentColors";

/**
 * The document's palette for whichever colour control asks for it.
 *
 * Deliberately reads the context with `useContext` rather than
 * `useEditorContext`: that hook THROWS outside an EditorProvider, and a colour
 * control should degrade to "brand + recents + saved" in a preview, a story, or
 * a standalone tool rather than crash the tree. An empty palette is a fine
 * answer; an exception is not.
 *
 * Memoised on the document identity. The document is an immutable value that is
 * replaced on every edit, so this recomputes exactly when content changed —
 * which is what keeps the palette from omitting the colour just applied.
 */
export function useDocumentColors(): readonly EditorColor[] {
  const editor = useContext(EditorContext);
  const doc = editor?.state.document ?? null;
  return useMemo(() => (doc ? collectDocumentColors(doc) : []), [doc]);
}
