"use client";

import {
  Archive,
  Clock,
  FileText,
  Files,
  Home,
  PenTool,
  Star,
  Trash2,
  type LucideIcon,
} from "lucide-react";

/**
 * The single icon registry for the authenticated shell.
 *
 * `appShellLogic.ts` stays renderer-agnostic by referring to icons with string
 * ids; this module is the only place those ids become components, so an icon
 * swap is one edit rather than a search across the shell.
 */
const ICONS: Record<string, LucideIcon> = {
  home: Home,
  documents: Files,
  favorites: Star,
  recent: Clock,
  archived: Archive,
  trash: Trash2,
  editor: PenTool,
  document: FileText,
};

/** Resolves an icon id, falling back to a neutral document glyph. */
export function appIcon(id: string): LucideIcon {
  return ICONS[id] ?? FileText;
}
