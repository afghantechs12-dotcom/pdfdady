import { execFile } from "node:child_process";

export type BinaryName =
  | "soffice"
  | "gs"
  | "qpdf"
  | "pdftoppm"
  | "pdfinfo"
  | "tesseract"
  | "ocrmypdf";

/** Friendly install hints surfaced to the user when a binary is missing. */
export const binaryInfo: Record<BinaryName, { label: string; apt: string }> = {
  soffice: { label: "LibreOffice", apt: "libreoffice" },
  gs: { label: "Ghostscript", apt: "ghostscript" },
  qpdf: { label: "qpdf", apt: "qpdf" },
  pdftoppm: { label: "Poppler utils", apt: "poppler-utils" },
  pdfinfo: { label: "Poppler utils", apt: "poppler-utils" },
  tesseract: { label: "Tesseract OCR", apt: "tesseract-ocr" },
  ocrmypdf: { label: "OCRmyPDF", apt: "ocrmypdf" },
};

function which(binary: string): Promise<boolean> {
  const finder = process.platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    execFile(finder, [binary], { windowsHide: true }, (error) => {
      resolve(!error);
    });
  });
}

export async function hasBinary(binary: BinaryName): Promise<boolean> {
  return which(binary);
}

/** Ensures a binary exists; throws a MissingDependencyError if not. */
export class MissingDependencyError extends Error {
  constructor(public readonly binary: BinaryName) {
    const info = binaryInfo[binary];
    super(
      `Server dependency missing: ${info.label} ("${binary}"). Install it (apt-get install ${info.apt}) or run PDFDadi via Docker.`,
    );
    this.name = "MissingDependencyError";
  }
}

export async function ensureBinary(binary: BinaryName): Promise<void> {
  if (!(await hasBinary(binary))) {
    throw new MissingDependencyError(binary);
  }
}

export async function checkAllDependencies(): Promise<
  Record<BinaryName, boolean>
> {
  const names = Object.keys(binaryInfo) as BinaryName[];
  const entries = await Promise.all(
    names.map(async (n) => [n, await hasBinary(n)] as const),
  );
  return Object.fromEntries(entries) as Record<BinaryName, boolean>;
}
