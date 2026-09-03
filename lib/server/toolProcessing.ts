import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCommand, CommandAbortedError } from "./runCommand";
import { ensureBinary } from "./dependencyCheck";
import { safeJoin } from "./tempFiles";
import { streamZipFiles } from "./zip";
import { OCR_LANG_CODES } from "@/data/serverToolConfig";
import { outputFileName } from "@/lib/workflow/fileNames";

export interface ProcessContext {
  inputPath: string;
  jobDir: string;
  baseName: string; // sanitized name without extension
  options: Record<string, string>;
  /**
   * Optional AbortSignal from the job worker. When it fires, the running
   * external binary is killed (CommandAbortedError) so cancellation takes
   * effect mid-process instead of waiting for the binary to finish.
   */
  signal?: AbortSignal;
}

export interface ServerOutput {
  outputPath: string;
  downloadName: string;
  mimeType: string;
}

export class ProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessingError";
  }
}

/**
 * The user-facing name for a server tool's output.
 *
 * Every processor routes through here so no server tool composes its own name:
 * the suffix is appended at most once and the extension is supplied by whoever
 * knows the output format, which is what keeps `.pdf.pdf` and
 * `-compressed-compressed` unreachable. `ctx.baseName` is already an
 * extension-less clean base, so it enters the policy as the base rather than as a
 * filename to be split.
 */
function outputName(ctx: ProcessContext, suffix: string | null, ext: string): string {
  return outputFileName({ fallbackBase: ctx.baseName, suffix, ext });
}

const LO_TIMEOUT = 180_000;

/** Isolated LibreOffice profile per job to avoid concurrency lock issues. */
function loProfileArg(jobDir: string): string {
  return `-env:UserInstallation=file://${path.join(jobDir, "lo-profile")}`;
}

/**
 * SSRF hardening for LibreOffice conversions. A crafted document can reference
 * remote images/objects that soffice would otherwise fetch on load, letting it
 * reach internal network hosts. We seed the per-job profile with settings that:
 *   - never auto-update document links (Writer/Calc),
 *   - use no proxy,
 *   - keep macro security at the highest level.
 * This is defense-in-depth: the definitive control is running the conversion
 * with no network egress (Docker `--network none` / firewall). See SERVER_SETUP.
 */
const LO_REGISTRY_XCU = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
 <item oor:path="/org.openoffice.Office.Common/Internet/Proxy"><prop oor:name="ProxyType" oor:op="fuse"><value>1</value></prop></item>
 <item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>
 <item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>
</oor:items>`;

/** Env that strips inherited proxy settings from the soffice child process. */
const LO_ENV: Record<string, string> = {
  http_proxy: "",
  https_proxy: "",
  HTTP_PROXY: "",
  HTTPS_PROXY: "",
  ftp_proxy: "",
  no_proxy: "*",
};

/** Writes the hardening registry into the per-job profile before running soffice. */
async function prepareLoProfile(jobDir: string): Promise<void> {
  const userDir = path.join(jobDir, "lo-profile", "user");
  await mkdir(userDir, { recursive: true });
  await writeFile(path.join(userDir, "registrymodifications.xcu"), LO_REGISTRY_XCU, "utf-8");
}

async function findOutput(
  jobDir: string,
  predicate: (name: string) => boolean,
): Promise<string | null> {
  const entries = await readdir(jobDir);
  const match = entries.find(predicate);
  return match ? path.join(jobDir, match) : null;
}

async function zipFiles(
  jobDir: string,
  files: string[],
  zipName: string,
): Promise<string> {
  // Stream the zip to disk via archiver (see lib/server/zip.ts) so a multi-page
  // pdf-to-images run never builds the whole archive in memory — JSZip's
  // generateAsync buffered the entire zip before writing a byte.
  return streamZipFiles(
    jobDir,
    files.map((f) => ({ filePath: f })),
    zipName,
  );
}

// ---------- Individual processors ----------

async function compress(ctx: ProcessContext): Promise<ServerOutput> {
  await ensureBinary("gs");
  const preset =
    ctx.options.level === "low"
      ? "/prepress"
      : ctx.options.level === "high"
        ? "/screen"
        : "/ebook";
  const out = safeJoin(ctx.jobDir, "compressed.pdf");
  await runCommand("gs", [
    "-dSAFER",
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.5",
    `-dPDFSETTINGS=${preset}`,
    "-dNOPAUSE",
    "-dQUIET",
    "-dBATCH",
    `-sOutputFile=${out}`,
    ctx.inputPath,
  ], { signal: ctx.signal });
  return {
    outputPath: out,
    downloadName: outputName(ctx, "compressed", "pdf"),
    mimeType: "application/pdf",
  };
}

async function repair(ctx: ProcessContext): Promise<ServerOutput> {
  const out = safeJoin(ctx.jobDir, "repaired.pdf");
  try {
    await ensureBinary("qpdf");
    await runCommand("qpdf", ["--linearize", ctx.inputPath, out], {
      signal: ctx.signal,
    });
  } catch (err) {
    // Cancellation must propagate, not trigger the gs fallback.
    if (err instanceof CommandAbortedError) throw err;
    // Fallback: rewrite through Ghostscript.
    await ensureBinary("gs");
    await runCommand("gs", [
      "-dSAFER",
      "-o",
      out,
      "-sDEVICE=pdfwrite",
      "-dNOPAUSE",
      "-dBATCH",
      "-dQUIET",
      ctx.inputPath,
    ], { signal: ctx.signal });
  }
  return {
    outputPath: out,
    downloadName: outputName(ctx, "repaired", "pdf"),
    mimeType: "application/pdf",
  };
}

/**
 * Validates the requested OCR language(s). Accepts a single pack or a
 * `+`-joined multilingual combo (e.g. "eng+deu"); drops any pack not in the
 * installed whitelist and falls back to "eng" if none are valid. Prevents an
 * ocrmypdf failure on an uninstalled language. The whitelist is the shared
 * `OCR_LANG_CODES` (single source with the `ocr-pdf` UI options).
 */
export function sanitizeOcrLang(requested: string): string {
  const parts = requested
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const valid = parts.filter((p) => OCR_LANG_CODES.includes(p));
  return valid.length > 0 ? valid.join("+") : "eng";
}

/**
 * The ocrmypdf flags for one OCR run, without the input/output paths.
 *
 * Exported so the flag list is reachable without ocrmypdf installed: it shipped
 * for a whole phase containing `--psm 3`, which ocrmypdf does not accept — its
 * pass-through for Tesseract's page-segmentation mode is
 * `--tesseract-pagesegmode`. ocrmypdf answered a usage error, `runCommand` raised
 * CommandError, and every OCR run in every environment ended as "The file may be
 * unsupported or damaged" about a perfectly good PDF. The only test here covered
 * `sanitizeOcrLang`, the one piece that was right.
 *
 * A unit test cannot know which flags a third-party CLI accepts, so it pins the
 * regression and the option wiring; the flag list is executed against the real
 * binary by `scripts/tool-runtime-matrix-probe.mjs`, which is what caught this.
 *
 *   --tesseract-oem 3          LSTM neural net (Tesseract 4+ default, explicit)
 *   --tesseract-pagesegmode 3  automatic page segmentation (robust default)
 *
 * `--deskew`/`--oversample` need Pillow, so they stay opt-in: a missing optional
 * extra must not break OCR for everyone.
 */
export function ocrCommandArgs(options: Record<string, string>): string[] {
  const args = [
    "-l",
    sanitizeOcrLang(options.language || "eng"),
    "--skip-text",
    "--tesseract-oem",
    "3",
    "--tesseract-pagesegmode",
    "3",
  ];
  if (options.deskew === "on") args.push("--deskew");
  const oversample = Number(options.oversample);
  if (Number.isInteger(oversample) && oversample >= 72 && oversample <= 600) {
    args.push("--oversample", String(oversample));
  }
  return args;
}

async function ocr(ctx: ProcessContext): Promise<ServerOutput> {
  // ocrmypdf shells out to tesseract; ensure both up front so a missing
  // dependency surfaces as a clear 503 (MissingDependencyError) rather than a
  // generic mid-run CommandError.
  await ensureBinary("ocrmypdf");
  await ensureBinary("tesseract");

  const out = safeJoin(ctx.jobDir, "ocr.pdf");
  const args = [...ocrCommandArgs(ctx.options), ctx.inputPath, out];
  await runCommand("ocrmypdf", args, { timeoutMs: 300_000, signal: ctx.signal });
  return {
    outputPath: out,
    downloadName: outputName(ctx, "ocr", "pdf"),
    mimeType: "application/pdf",
  };
}

async function officeToPdf(ctx: ProcessContext): Promise<ServerOutput> {
  await ensureBinary("soffice");
  await prepareLoProfile(ctx.jobDir);
  await runCommand(
    "soffice",
    [
      "--headless",
      loProfileArg(ctx.jobDir),
      "--convert-to",
      "pdf",
      "--outdir",
      ctx.jobDir,
      ctx.inputPath,
    ],
    { timeoutMs: LO_TIMEOUT, env: LO_ENV, signal: ctx.signal },
  );
  const out = await findOutput(
    ctx.jobDir,
    (n) => n.toLowerCase().endsWith(".pdf") && n !== path.basename(ctx.inputPath),
  );
  if (!out) {
    throw new ProcessingError("Conversion did not produce a PDF.");
  }
  return {
    outputPath: out,
    downloadName: outputName(ctx, null, "pdf"),
    mimeType: "application/pdf",
  };
}

/**
 * Max pages rendered by pdf-to-images. A huge PDF would otherwise render
 * hundreds/thousands of high-res images into a single zip — bounding the page
 * count caps the worst-case time, temp disk, and output size. Tune via
 * PDF_TO_IMAGES_MAX_PAGES. The error is actionable (split the PDF first).
 */
const PARSED_MAX_IMG_PAGES = Number(process.env.PDF_TO_IMAGES_MAX_PAGES);
const PDF_TO_IMAGES_MAX_PAGES =
  Number.isInteger(PARSED_MAX_IMG_PAGES) && PARSED_MAX_IMG_PAGES > 0
    ? PARSED_MAX_IMG_PAGES
    : 200;

/** Reads the page count from `pdfinfo` (poppler) — a lightweight metadata read. */
async function getPdfPageCount(
  inputPath: string,
  signal?: AbortSignal,
): Promise<number> {
  const { stdout } = await runCommand("pdfinfo", [inputPath], { signal });
  const match = stdout.match(/^Pages:\s+(\d+)/m);
  return match ? Number(match[1]) : 0;
}

async function pdfToImages(
  ctx: ProcessContext,
  format: "jpeg" | "png",
): Promise<ServerOutput> {
  await ensureBinary("pdftoppm");
  await ensureBinary("pdfinfo");

  // Bound the work for large documents before rendering (a 1000-page PDF would
  // otherwise produce a giant image zip). pdfinfo only reads metadata.
  const pageCount = await getPdfPageCount(ctx.inputPath, ctx.signal);
  if (pageCount > PDF_TO_IMAGES_MAX_PAGES) {
    throw new ProcessingError(
      `This PDF has ${pageCount} pages. Image extraction supports up to ${PDF_TO_IMAGES_MAX_PAGES} pages — please split the PDF first.`,
    );
  }

  const prefix = path.join(ctx.jobDir, "page");
  const flag = format === "jpeg" ? "-jpeg" : "-png";
  await runCommand("pdftoppm", [flag, "-r", "150", ctx.inputPath, prefix], {
    timeoutMs: 300_000,
    signal: ctx.signal,
  });

  const ext = format === "jpeg" ? ".jpg" : ".png";
  const entries = (await readdir(ctx.jobDir))
    .filter((n) => n.startsWith("page") && n.toLowerCase().endsWith(ext))
    .sort();
  if (entries.length === 0) {
    throw new ProcessingError("No pages were rendered.");
  }

  const fullPaths = entries.map((n) => path.join(ctx.jobDir, n));
  if (fullPaths.length === 1) {
    return {
      outputPath: fullPaths[0],
      downloadName: outputName(ctx, null, ext),
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
    };
  }
  const zip = await zipFiles(ctx.jobDir, fullPaths, outputName(ctx, format, "zip"));
  return {
    outputPath: zip,
    downloadName: outputName(ctx, format, "zip"),
    mimeType: "application/zip",
  };
}

async function pdfToWord(ctx: ProcessContext): Promise<ServerOutput> {
  await ensureBinary("soffice");
  await prepareLoProfile(ctx.jobDir);
  await runCommand(
    "soffice",
    [
      "--headless",
      loProfileArg(ctx.jobDir),
      "--infilter=writer_pdf_import",
      "--convert-to",
      "docx:MS Word 2007 XML",
      "--outdir",
      ctx.jobDir,
      ctx.inputPath,
    ],
    { timeoutMs: LO_TIMEOUT, env: LO_ENV, signal: ctx.signal },
  );
  const out = await findOutput(ctx.jobDir, (n) =>
    n.toLowerCase().endsWith(".docx"),
  );
  if (!out) {
    throw new ProcessingError("Conversion did not produce a Word file.");
  }
  return {
    outputPath: out,
    downloadName: outputName(ctx, null, "docx"),
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
}

async function pdfToPdfa(ctx: ProcessContext): Promise<ServerOutput> {
  await ensureBinary("gs");
  const out = safeJoin(ctx.jobDir, "pdfa.pdf");
  await runCommand("gs", [
    "-dSAFER",
    "-dPDFA=2",
    "-dBATCH",
    "-dNOPAUSE",
    "-dQUIET",
    "-sColorConversionStrategy=UseDeviceIndependentColor",
    "-sDEVICE=pdfwrite",
    "-dPDFACompatibilityPolicy=1",
    `-sOutputFile=${out}`,
    ctx.inputPath,
  ], { signal: ctx.signal });
  return {
    outputPath: out,
    downloadName: outputName(ctx, "pdfa", "pdf"),
    mimeType: "application/pdf",
  };
}

async function htmlToPdf(ctx: ProcessContext): Promise<ServerOutput> {
  return officeToPdf(ctx);
}

async function protect(ctx: ProcessContext): Promise<ServerOutput> {
  await ensureBinary("qpdf");
  const password = ctx.options.password;
  if (!password || password.length < 4) {
    throw new ProcessingError("Password must be at least 4 characters.");
  }
  // qpdf parses --encrypt arguments positionally; a password starting with
  // "-" is consumed as an unknown flag and the command fails with a generic
  // error. Reject it up front with an actionable message.
  if (password.startsWith("-")) {
    throw new ProcessingError("Password can't start with a dash (-).");
  }
  const out = safeJoin(ctx.jobDir, "protected.pdf");
  await runCommand("qpdf", [
    "--encrypt",
    password,
    password,
    "256",
    "--",
    ctx.inputPath,
    out,
  ], { signal: ctx.signal });
  return {
    outputPath: out,
    downloadName: outputName(ctx, "protected", "pdf"),
    mimeType: "application/pdf",
  };
}

async function unlock(ctx: ProcessContext): Promise<ServerOutput> {
  await ensureBinary("qpdf");
  const password = ctx.options.password ?? "";
  const out = safeJoin(ctx.jobDir, "unlocked.pdf");
  try {
    await runCommand("qpdf", [
      `--password=${password}`,
      "--decrypt",
      ctx.inputPath,
      out,
    ], { signal: ctx.signal });
  } catch (err) {
    // Cancellation must propagate, not be reported as a wrong password.
    if (err instanceof CommandAbortedError) throw err;
    throw new ProcessingError(
      "Could not unlock the PDF. The password may be incorrect.",
    );
  }
  return {
    outputPath: out,
    downloadName: outputName(ctx, "unlocked", "pdf"),
    mimeType: "application/pdf",
  };
}

async function flatten(ctx: ProcessContext): Promise<ServerOutput> {
  await ensureBinary("qpdf");
  const out = safeJoin(ctx.jobDir, "flattened.pdf");
  await runCommand("qpdf", [
    "--flatten-annotations=all",
    "--generate-appearances",
    ctx.inputPath,
    out,
  ], { signal: ctx.signal });
  return {
    outputPath: out,
    downloadName: outputName(ctx, "flattened", "pdf"),
    mimeType: "application/pdf",
  };
}

// ---------- Registry ----------

type Processor = (ctx: ProcessContext) => Promise<ServerOutput>;

export const processors: Record<string, Processor> = {
  "compress-pdf": compress,
  "repair-pdf": repair,
  "ocr-pdf": ocr,
  "word-to-pdf": officeToPdf,
  "powerpoint-to-pdf": officeToPdf,
  "excel-to-pdf": officeToPdf,
  "html-to-pdf": htmlToPdf,
  "pdf-to-jpg": (ctx) => pdfToImages(ctx, "jpeg"),
  "pdf-to-png": (ctx) => pdfToImages(ctx, "png"),
  "pdf-to-word": pdfToWord,
  "pdf-to-pdfa": pdfToPdfa,
  "protect-pdf": protect,
  "unlock-pdf": unlock,
  "flatten-pdf": flatten,
};

export function getProcessor(slug: string): Processor | undefined {
  return processors[slug];
}
