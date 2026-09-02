import type { IconTone } from "@/styles/tokens";

export type ToolStatus =
  | "functional-client" // works fully in the browser
  | "functional-server" // works through a server API route
  | "planned" // normal tool not yet reliably implementable (with reason)
  | "coming-soon-ai"; // AI future tool

export type ToolCategory =
  | "organize"
  | "optimize"
  | "convert-to"
  | "convert-from"
  | "edit"
  | "security"
  | "ai";

export interface Tool {
  slug: string;
  name: string;
  description: string;
  href: string;
  icon: string; // lucide-react icon name
  iconTone: IconTone;
  status: ToolStatus;
  category: ToolCategory;
  accept: string[]; // MIME types for the upload UI
  multiple: boolean;
  plannedReason?: string; // required when status === "planned"
}

const PDF = ["application/pdf"];
const PNG = ["image/png"];
const IMG = ["image/jpeg", "image/png"];
const DOC = [
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];
const PPT = [
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];
const XLS = [
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];
const HTML = ["text/html"];

function tool(t: Omit<Tool, "href">): Tool {
  return { ...t, href: `/tools/${t.slug}` };
}

export const tools: Tool[] = [
  // ---------- A. Organize PDF ----------
  tool({
    slug: "merge-pdf",
    name: "Merge PDF",
    description: "Combine multiple PDF files into one document.",
    icon: "Combine",
    iconTone: "purple",
    status: "functional-client",
    category: "organize",
    accept: PDF,
    multiple: true,
  }),
  tool({
    slug: "split-pdf",
    name: "Split PDF",
    description: "Extract a page range or split a PDF into a new file.",
    icon: "Scissors",
    iconTone: "blue",
    status: "functional-client",
    category: "organize",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "organize-pdf",
    name: "Organize PDF",
    description: "Rotate, delete and reorder pages in one place.",
    icon: "LayoutGrid",
    iconTone: "purple",
    status: "functional-client",
    category: "organize",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "rotate-pdf",
    name: "Rotate PDF",
    description: "Rotate pages to the correct orientation.",
    icon: "RotateCw",
    iconTone: "blue",
    status: "functional-client",
    category: "organize",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "delete-pdf-pages",
    name: "Delete PDF Pages",
    description: "Remove unwanted pages from your PDF.",
    icon: "FileMinus",
    iconTone: "blue",
    status: "functional-client",
    category: "organize",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "reorder-pdf-pages",
    name: "Reorder PDF Pages",
    description: "Change the order of pages in your PDF.",
    icon: "ArrowUpDown",
    iconTone: "purple",
    status: "functional-client",
    category: "organize",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "extract-pdf-pages",
    name: "Extract PDF Pages",
    description: "Pull out a range of pages into a new PDF.",
    icon: "FileOutput",
    iconTone: "teal",
    status: "functional-client",
    category: "organize",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "crop-pdf",
    name: "Crop PDF",
    description: "Trim page margins by a chosen amount.",
    icon: "Crop",
    iconTone: "blue",
    status: "functional-client",
    category: "organize",
    accept: PDF,
    multiple: false,
  }),

  // ---------- B. Optimize PDF ----------
  tool({
    slug: "compress-pdf",
    name: "Compress PDF",
    description: "Reduce PDF file size with quality presets.",
    icon: "Minimize2",
    iconTone: "green",
    status: "functional-server",
    category: "optimize",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "repair-pdf",
    name: "Repair PDF",
    description: "Rebuild and recover a damaged PDF.",
    icon: "Wrench",
    iconTone: "green",
    status: "functional-server",
    category: "optimize",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "ocr-pdf",
    name: "OCR PDF",
    description: "Make scanned PDFs searchable with text recognition.",
    icon: "ScanText",
    iconTone: "green",
    status: "functional-server",
    category: "optimize",
    accept: PDF,
    multiple: false,
  }),

  // ---------- C. Convert to PDF ----------
  tool({
    slug: "jpg-to-pdf",
    name: "JPG to PDF",
    description: "Turn JPG images into a single PDF document.",
    icon: "Image",
    iconTone: "pink",
    status: "functional-client",
    category: "convert-to",
    accept: IMG,
    multiple: true,
  }),
  tool({
    slug: "png-to-pdf",
    name: "PNG to PDF",
    description: "Convert PNG images into a single PDF document.",
    icon: "FileImage",
    iconTone: "pink",
    status: "functional-client",
    category: "convert-to",
    accept: PNG,
    multiple: true,
  }),
  tool({
    slug: "image-to-pdf",
    name: "Image to PDF",
    description: "Convert JPG and PNG images into one PDF.",
    icon: "Images",
    iconTone: "orange",
    status: "functional-client",
    category: "convert-to",
    accept: IMG,
    multiple: true,
  }),
  tool({
    slug: "word-to-pdf",
    name: "Word to PDF",
    description: "Convert DOC and DOCX documents into PDF.",
    icon: "FileType",
    iconTone: "orange",
    status: "functional-server",
    category: "convert-to",
    accept: DOC,
    multiple: false,
  }),
  tool({
    slug: "powerpoint-to-pdf",
    name: "PowerPoint to PDF",
    description: "Convert PPT and PPTX presentations into PDF.",
    icon: "Presentation",
    iconTone: "orange",
    status: "functional-server",
    category: "convert-to",
    accept: PPT,
    multiple: false,
  }),
  tool({
    slug: "excel-to-pdf",
    name: "Excel to PDF",
    description: "Convert XLS and XLSX spreadsheets into PDF.",
    icon: "Sheet",
    iconTone: "green",
    status: "functional-server",
    category: "convert-to",
    accept: XLS,
    multiple: false,
  }),
  tool({
    slug: "html-to-pdf",
    name: "HTML to PDF",
    description: "Convert an HTML file into a PDF document.",
    icon: "Code",
    iconTone: "orange",
    status: "functional-server",
    category: "convert-to",
    accept: HTML,
    multiple: false,
  }),

  // ---------- D. Convert from PDF ----------
  tool({
    slug: "pdf-to-jpg",
    name: "PDF to JPG",
    description: "Export each PDF page as a JPG image.",
    icon: "Image",
    iconTone: "blue",
    status: "functional-server",
    category: "convert-from",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "pdf-to-png",
    name: "PDF to PNG",
    description: "Export each PDF page as a PNG image.",
    icon: "FileImage",
    iconTone: "blue",
    status: "functional-server",
    category: "convert-from",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "pdf-to-word",
    name: "PDF to Word",
    description: "Convert a PDF into an editable Word file (best effort).",
    icon: "FileText",
    iconTone: "blue",
    status: "functional-server",
    category: "convert-from",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "pdf-to-powerpoint",
    name: "PDF to PowerPoint",
    description: "Convert a PDF into an editable presentation.",
    icon: "Presentation",
    iconTone: "orange",
    status: "planned",
    category: "convert-from",
    accept: PDF,
    multiple: false,
    plannedReason:
      "No reliable open-source tool converts a PDF into an editable PowerPoint. LibreOffice's PDF import targets Draw/Writer, not Impress, and produces unusable slides — so we won't ship a fake conversion.",
  }),
  tool({
    slug: "pdf-to-excel",
    name: "PDF to Excel",
    description: "Extract PDF tables into an editable spreadsheet.",
    icon: "Table2",
    iconTone: "green",
    status: "planned",
    category: "convert-from",
    accept: PDF,
    multiple: false,
    plannedReason:
      "Reliable table extraction requires Camelot/Tabula (Python + Java) and still fails on complex or scanned layouts. We're integrating a dedicated extraction service rather than returning inaccurate data.",
  }),
  tool({
    slug: "pdf-to-pdfa",
    name: "PDF to PDF/A",
    description: "Convert PDFs to the PDF/A archival standard.",
    icon: "FileCheck",
    iconTone: "blue",
    status: "functional-server",
    category: "convert-from",
    accept: PDF,
    multiple: false,
  }),

  // ---------- E. Edit PDF ----------
  tool({
    slug: "edit-pdf",
    name: "Edit PDF",
    // What this route actually does: `EditTool`, the same component
    // `/tools/organize-pdf` renders — page rotate/delete/reorder, nothing more.
    // The full editor (text, images, signatures, annotations, shapes, drawing,
    // crop) is the standalone surface at `/editor`, which is not a registry
    // tool. The description names both so neither is oversold.
    description:
      "Rotate, delete and reorder pages. For text, images and signatures, open the full editor.",
    icon: "PenLine",
    iconTone: "teal",
    status: "functional-client",
    category: "edit",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "add-page-numbers",
    name: "Add Page Numbers",
    description: "Insert page numbers into your PDF.",
    icon: "Hash",
    iconTone: "teal",
    status: "functional-client",
    category: "edit",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "add-watermark",
    name: "Add Watermark",
    description: "Stamp a text watermark across every page.",
    icon: "Stamp",
    iconTone: "purple",
    status: "functional-client",
    category: "edit",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "annotate-pdf",
    name: "Annotate PDF",
    description: "Add a text note to a chosen page.",
    icon: "Highlighter",
    iconTone: "teal",
    status: "functional-client",
    category: "edit",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "fill-pdf-forms",
    name: "Fill PDF Forms",
    description: "Detect and fill interactive PDF form fields.",
    icon: "FormInput",
    iconTone: "teal",
    status: "functional-client",
    category: "edit",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "pdf-forms",
    name: "PDF Forms",
    description: "Design and create interactive PDF forms.",
    icon: "ClipboardList",
    iconTone: "teal",
    status: "planned",
    category: "edit",
    accept: PDF,
    multiple: false,
    plannedReason:
      "Creating new interactive forms requires a full drag-and-drop form-builder UI (field placement, validation rules, export). That editor is a large feature scheduled after the core toolkit. You can already fill existing forms with Fill PDF Forms.",
  }),
  tool({
    slug: "sign-pdf",
    name: "Sign PDF",
    description: "Place a signature image on your PDF (visual signature).",
    icon: "PenTool",
    iconTone: "purple",
    status: "functional-client",
    category: "edit",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "redact-pdf",
    name: "Redact PDF",
    description: "Permanently remove sensitive content.",
    icon: "EyeOff",
    iconTone: "red",
    status: "planned",
    category: "edit",
    accept: PDF,
    multiple: false,
    plannedReason:
      "True redaction must remove the underlying text and objects, not just draw black boxes over them. Doing this safely requires PyMuPDF-based content removal. We will not ship box-only 'redaction' that leaves the real text recoverable.",
  }),
  tool({
    slug: "compare-pdf",
    name: "Compare PDF",
    description: "Highlight visual differences between two PDFs.",
    icon: "GitCompare",
    iconTone: "blue",
    status: "planned",
    category: "edit",
    accept: PDF,
    multiple: true,
    plannedReason:
      "A trustworthy compare renders every page of both files, aligns them, and diffs the images into a report. That rendering+diff pipeline is being built next; a half-working version would mislead more than it helps.",
  }),

  // ---------- F. PDF Security ----------
  tool({
    slug: "protect-pdf",
    name: "Protect PDF",
    description: "Add a password and encrypt your PDF.",
    icon: "Lock",
    iconTone: "red",
    status: "functional-server",
    category: "security",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "unlock-pdf",
    name: "Unlock PDF",
    description: "Remove a password from a PDF you own.",
    icon: "LockOpen",
    iconTone: "red",
    status: "functional-server",
    category: "security",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "remove-pdf-metadata",
    name: "Remove PDF Metadata",
    description: "Strip author, title and other metadata.",
    icon: "FileX",
    iconTone: "red",
    status: "functional-client",
    category: "security",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "flatten-pdf",
    name: "Flatten PDF",
    description: "Flatten annotations and form fields into the page.",
    icon: "Layers",
    iconTone: "orange",
    status: "functional-server",
    category: "security",
    accept: PDF,
    multiple: false,
  }),

  // ---------- G. AI PDF Tools ----------
  tool({
    slug: "chat-with-pdf",
    name: "Chat with PDF",
    description: "Ask questions about your documents.",
    icon: "MessagesSquare",
    iconTone: "pink",
    status: "coming-soon-ai",
    category: "ai",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "summarize-pdf",
    name: "Summarize PDF",
    description: "Get the key points in seconds.",
    icon: "ListChecks",
    iconTone: "pink",
    status: "coming-soon-ai",
    category: "ai",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "translate-pdf",
    name: "Translate PDF",
    description: "Translate document content instantly.",
    icon: "Languages",
    iconTone: "pink",
    status: "coming-soon-ai",
    category: "ai",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "explain-german-letters",
    name: "Explain German Letters",
    description: "Understand official letters with ease.",
    icon: "FileSearch",
    iconTone: "pink",
    status: "coming-soon-ai",
    category: "ai",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "invoice-to-excel",
    name: "Invoice to Excel",
    description: "Extract invoice data and export to Excel.",
    icon: "Table2",
    iconTone: "pink",
    status: "coming-soon-ai",
    category: "ai",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "smart-split-pdf",
    name: "Smart Split PDF",
    description: "Let AI split documents at the right places.",
    icon: "Wand2",
    iconTone: "pink",
    status: "coming-soon-ai",
    category: "ai",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "contract-explainer",
    name: "Contract Explainer",
    description: "Understand contracts in plain language.",
    icon: "ScrollText",
    iconTone: "pink",
    status: "coming-soon-ai",
    category: "ai",
    accept: PDF,
    multiple: false,
  }),
  tool({
    slug: "ai-redaction-assistant",
    name: "AI Redaction Assistant",
    description: "Find sensitive data to redact automatically.",
    icon: "ShieldOff",
    iconTone: "pink",
    status: "coming-soon-ai",
    category: "ai",
    accept: PDF,
    multiple: false,
  }),
];

export function getToolBySlug(slug: string): Tool | undefined {
  return tools.find((t) => t.slug === slug);
}

export function isFunctional(tool: Tool): boolean {
  return (
    tool.status === "functional-client" || tool.status === "functional-server"
  );
}

// Curated set shown in the homepage "Essential PDF tools" section (8 only).
// Named for what it is: a manual pick, not a usage ranking. The public heading
// says "Essential" for the same reason (docs/launch-feature-evidence.md, C13).
const POPULAR_SLUGS = [
  "merge-pdf",
  "split-pdf",
  "compress-pdf",
  "pdf-to-word",
  "jpg-to-pdf",
  "edit-pdf",
  "protect-pdf",
  "ocr-pdf",
];

export const popularTools: Tool[] = POPULAR_SLUGS.map(
  (slug) => getToolBySlug(slug)!,
);
