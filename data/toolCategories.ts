import type { ToolCategory } from "./tools";

export interface CategoryMeta {
  id: ToolCategory;
  label: string;
  tabLabel: string;
}

// Order here drives both the catalog tabs and the section order.
export const toolCategories: CategoryMeta[] = [
  { id: "organize", label: "Organize PDF", tabLabel: "Organize PDF" },
  { id: "optimize", label: "Optimize PDF", tabLabel: "Optimize PDF" },
  { id: "convert-to", label: "Convert to PDF", tabLabel: "Convert to PDF" },
  { id: "convert-from", label: "Convert from PDF", tabLabel: "Convert from PDF" },
  { id: "edit", label: "Edit PDF", tabLabel: "Edit PDF" },
  { id: "security", label: "PDF Security", tabLabel: "Security" },
  { id: "ai", label: "AI PDF Tools", tabLabel: "AI Tools" },
];
