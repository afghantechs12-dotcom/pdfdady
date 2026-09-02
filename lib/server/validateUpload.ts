import path from "node:path";
import type { ServerToolConfig } from "@/data/serverToolConfig";

export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadValidationError";
  }
}

export interface ValidatedUpload {
  buffer: Buffer;
  originalName: string;
  ext: string;
  size: number;
  /** Best-effort MIME type (the File's type, or the first accepted type). */
  mimeType: string;
}

/**
 * Validates a single uploaded File against a tool config: presence, size,
 * extension, and MIME type. Throws UploadValidationError with a clear message.
 */
export async function validateUpload(
  file: unknown,
  config: ServerToolConfig,
): Promise<ValidatedUpload> {
  if (!(file instanceof File)) {
    throw new UploadValidationError("No file was provided.");
  }
  if (file.size === 0) {
    throw new UploadValidationError("The uploaded file is empty.");
  }
  if (file.size > config.maxSizeBytes) {
    const mb = Math.round(config.maxSizeBytes / (1024 * 1024));
    throw new UploadValidationError(`File exceeds the ${mb}MB limit.`);
  }

  const ext = path.extname(file.name).toLowerCase();
  if (!config.extensions.includes(ext)) {
    throw new UploadValidationError(
      `Unsupported file extension. Allowed: ${config.extensions.join(", ")}.`,
    );
  }

  // MIME can be empty or generic from some browsers; accept if extension is
  // valid, but reject an explicit, clearly-wrong MIME.
  if (
    file.type &&
    !config.accept.includes(file.type) &&
    file.type !== "application/octet-stream"
  ) {
    throw new UploadValidationError("Unsupported file type.");
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  assertMagicMatchesExtension(buffer, ext);
  // Browsers may report an empty/generic MIME; fall back to the first accepted
  // type so the stored file has a useful content type.
  const mimeType = file.type && file.type !== "application/octet-stream"
    ? file.type
    : config.accept[0];
  return { buffer, originalName: file.name, ext, size: file.size, mimeType };
}

/**
 * Content-sniffing defense: the browser-supplied extension and MIME type are
 * both spoofable, so we verify the file's leading bytes actually match the
 * claimed type before handing it to a native binary. Office formats (.docx,
 * .xlsx, .pptx) are ZIP containers; legacy Office formats are OLE compound
 * files. HTML has no reliable signature, so it's exempt.
 */
function assertMagicMatchesExtension(buffer: Buffer, ext: string): void {
  const startsWith = (sig: number[]) =>
    sig.every((b, i) => buffer[i] === b);

  const isPdf = startsWith([0x25, 0x50, 0x44, 0x46]); // %PDF
  const isZip = startsWith([0x50, 0x4b, 0x03, 0x04]) || startsWith([0x50, 0x4b, 0x05, 0x06]);
  const isOle = startsWith([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const isJpeg = startsWith([0xff, 0xd8, 0xff]);
  const isPng = startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const fail = () =>
    new UploadValidationError(
      "File content does not match its extension. The file may be corrupt or mislabeled.",
    );

  switch (ext) {
    case ".pdf":
      if (!isPdf) throw fail();
      break;
    case ".jpg":
    case ".jpeg":
      if (!isJpeg) throw fail();
      break;
    case ".png":
      if (!isPng) throw fail();
      break;
    case ".docx":
    case ".xlsx":
    case ".pptx":
      if (!isZip) throw fail();
      break;
    case ".doc":
    case ".ppt":
    case ".xls":
      if (!isOle) throw fail();
      break;
    // .html/.htm and anything else: no reliable magic signature — skip.
    default:
      break;
  }
}
