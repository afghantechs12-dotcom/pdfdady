export type OptionField =
  | {
      kind: "select";
      name: string;
      label: string;
      options: { value: string; label: string }[];
      default: string;
    }
  | {
      kind: "password";
      name: string;
      label: string;
      placeholder?: string;
      required?: boolean;
    };

export interface ServerToolConfig {
  accept: string[]; // MIME types for the upload UI + server validation
  extensions: string[]; // allowed extensions (lowercase, with dot)
  maxSizeBytes: number;
  buttonLabel: string;
  processingLabel: string;
  options: OptionField[];
  uploadTitle: string;
  acceptHint: string;
  resultNote?: string;
  showSizeComparison?: boolean;
}

const MB = 1024 * 1024;
const PDF = ["application/pdf"];

/**
 * Installed OCR (Tesseract) language packs — the SINGLE source for both the
 * `ocr-pdf` language select options below AND `sanitizeOcrLang` in
 * lib/server/toolProcessing.ts (which imports `OCR_LANG_CODES`). Adding a pack
 * here updates the UI options + the server-side validation together; keep this
 * in sync with the Dockerfile / SERVER_SETUP.md apt list (eng/deu/fra/spa).
 */
export const OCR_LANG_PACKS = [
  { code: "eng", label: "English" },
  { code: "deu", label: "German" },
  { code: "fra", label: "French" },
  { code: "spa", label: "Spanish" },
] as const;

/** Valid OCR language codes, derived from OCR_LANG_PACKS. */
export const OCR_LANG_CODES: readonly string[] = OCR_LANG_PACKS.map(
  (p) => p.code,
);

export const serverToolConfig: Record<string, ServerToolConfig> = {
  "compress-pdf": {
    accept: PDF,
    extensions: [".pdf"],
    maxSizeBytes: 100 * MB,
    buttonLabel: "Compress PDF",
    processingLabel: "Compressing…",
    uploadTitle: "Drop your PDF here",
    acceptHint: "Select one PDF · Max 100MB",
    showSizeComparison: true,
    options: [
      {
        kind: "select",
        name: "level",
        label: "Compression level",
        default: "medium",
        options: [
          { value: "low", label: "Low compression (high quality)" },
          { value: "medium", label: "Medium compression" },
          { value: "high", label: "High compression (smallest size)" },
        ],
      },
    ],
  },
  "repair-pdf": {
    accept: PDF,
    extensions: [".pdf"],
    maxSizeBytes: 100 * MB,
    buttonLabel: "Repair PDF",
    processingLabel: "Repairing…",
    uploadTitle: "Drop your damaged PDF here",
    acceptHint: "Select one PDF · Max 100MB",
    options: [],
  },
  "ocr-pdf": {
    accept: PDF,
    extensions: [".pdf"],
    maxSizeBytes: 100 * MB,
    buttonLabel: "Run OCR",
    processingLabel: "Recognizing text…",
    uploadTitle: "Drop your scanned PDF here",
    acceptHint: "Select one PDF · Max 100MB",
    options: [
      {
        kind: "select",
        name: "language",
        label: "Document language",
        default: "eng",
        options: OCR_LANG_PACKS.map(({ code, label }) => ({
          value: code,
          label,
        })),
      },
      {
        kind: "select",
        name: "deskew",
        label: "Deskew (straighten crooked scans)",
        default: "off",
        options: [
          { value: "off", label: "Off" },
          { value: "on", label: "On (improves accuracy on skewed scans)" },
        ],
      },
      {
        kind: "select",
        name: "oversample",
        label: "Upscale low-DPI scans",
        default: "0",
        options: [
          { value: "0", label: "No upscaling" },
          { value: "300", label: "To 300 DPI" },
          { value: "400", label: "To 400 DPI" },
        ],
      },
    ],
  },
  "word-to-pdf": {
    accept: [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    extensions: [".doc", ".docx"],
    maxSizeBytes: 50 * MB,
    buttonLabel: "Convert to PDF",
    processingLabel: "Converting…",
    uploadTitle: "Drop your Word file here",
    acceptHint: "DOC or DOCX · Max 50MB",
    options: [],
  },
  "powerpoint-to-pdf": {
    accept: [
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    extensions: [".ppt", ".pptx"],
    maxSizeBytes: 50 * MB,
    buttonLabel: "Convert to PDF",
    processingLabel: "Converting…",
    uploadTitle: "Drop your PowerPoint file here",
    acceptHint: "PPT or PPTX · Max 50MB",
    options: [],
  },
  "excel-to-pdf": {
    accept: [
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    extensions: [".xls", ".xlsx"],
    maxSizeBytes: 50 * MB,
    buttonLabel: "Convert to PDF",
    processingLabel: "Converting…",
    uploadTitle: "Drop your Excel file here",
    acceptHint: "XLS or XLSX · Max 50MB",
    options: [],
  },
  "html-to-pdf": {
    accept: ["text/html"],
    extensions: [".html", ".htm"],
    maxSizeBytes: 20 * MB,
    buttonLabel: "Convert to PDF",
    processingLabel: "Converting…",
    uploadTitle: "Drop your HTML file here",
    acceptHint: "HTML file · Max 20MB",
    options: [],
  },
  "pdf-to-jpg": {
    accept: PDF,
    extensions: [".pdf"],
    maxSizeBytes: 100 * MB,
    buttonLabel: "Convert to JPG",
    processingLabel: "Rendering pages…",
    uploadTitle: "Drop your PDF here",
    acceptHint: "Select one PDF · Max 100MB",
    resultNote: "Multiple pages are returned as a ZIP archive.",
    options: [],
  },
  "pdf-to-png": {
    accept: PDF,
    extensions: [".pdf"],
    maxSizeBytes: 100 * MB,
    buttonLabel: "Convert to PNG",
    processingLabel: "Rendering pages…",
    uploadTitle: "Drop your PDF here",
    acceptHint: "Select one PDF · Max 100MB",
    resultNote: "Multiple pages are returned as a ZIP archive.",
    options: [],
  },
  "pdf-to-word": {
    accept: PDF,
    extensions: [".pdf"],
    maxSizeBytes: 50 * MB,
    buttonLabel: "Convert to Word",
    processingLabel: "Converting…",
    uploadTitle: "Drop your PDF here",
    acceptHint: "Select one PDF · Max 50MB",
    resultNote:
      "Best-effort conversion. Complex layouts may not transfer perfectly.",
    options: [],
  },
  "pdf-to-pdfa": {
    accept: PDF,
    extensions: [".pdf"],
    maxSizeBytes: 100 * MB,
    buttonLabel: "Convert to PDF/A",
    processingLabel: "Converting…",
    uploadTitle: "Drop your PDF here",
    acceptHint: "Select one PDF · Max 100MB",
    options: [],
  },
  "protect-pdf": {
    accept: PDF,
    extensions: [".pdf"],
    maxSizeBytes: 100 * MB,
    buttonLabel: "Protect PDF",
    processingLabel: "Encrypting…",
    uploadTitle: "Drop your PDF here",
    acceptHint: "Select one PDF · Max 100MB",
    options: [
      {
        kind: "password",
        name: "password",
        label: "Password",
        placeholder: "Choose a password",
        required: true,
      },
    ],
  },
  "unlock-pdf": {
    accept: PDF,
    extensions: [".pdf"],
    maxSizeBytes: 100 * MB,
    buttonLabel: "Unlock PDF",
    processingLabel: "Removing password…",
    uploadTitle: "Drop your protected PDF here",
    acceptHint: "Select one PDF · Max 100MB",
    resultNote:
      "Only unlock files you own or have permission to modify.",
    options: [
      {
        kind: "password",
        name: "password",
        label: "Current password",
        placeholder: "Enter the PDF password",
        required: true,
      },
    ],
  },
  "flatten-pdf": {
    accept: PDF,
    extensions: [".pdf"],
    maxSizeBytes: 100 * MB,
    buttonLabel: "Flatten PDF",
    processingLabel: "Flattening…",
    uploadTitle: "Drop your PDF here",
    acceptHint: "Select one PDF · Max 100MB",
    options: [],
  },
};

export function getServerToolConfig(slug: string): ServerToolConfig | undefined {
  return serverToolConfig[slug];
}

/**
 * Slugs that produce a single output file per input — eligible for batch
 * processing (N inputs → one zip of N outputs). The image extractors are
 * excluded: a multi-page input already yields a zip, so batching would nest
 * zips. Shared by the server route and the client (both import this module).
 */
const BATCH_INELIGIBLE = new Set(["pdf-to-jpg", "pdf-to-png"]);

export function isBatchEligible(slug: string): boolean {
  return !!serverToolConfig[slug] && !BATCH_INELIGIBLE.has(slug);
}

/**
 * Max files accepted in one batch. Bounds per-job work and the output zip size.
 * Enforced by the server route (400 over the cap) and mirrored by the client
 * (rejects extra files in the dropzone).
 */
export const TOOLS_BATCH_MAX_FILES = 20;

