import { PdfProcessingError, type ProcessedResult } from "./types";

/**
 * Reads the EXIF Orientation tag (1–8) from raw JPEG bytes, or 1 when absent.
 * Walks the JPEG markers to the APP1/Exif segment and reads IFD0 tag 0x0112.
 */
function jpegExifOrientation(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return 1;
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset);
    const size = view.getUint16(offset + 2);
    if (marker === 0xffe1 && offset + 10 <= view.byteLength) {
      // APP1: check for "Exif\0\0"
      if (view.getUint32(offset + 4) === 0x45786966) {
        const tiff = offset + 10;
        if (tiff + 8 > view.byteLength) return 1;
        const little = view.getUint16(tiff) === 0x4949;
        const ifd = tiff + view.getUint32(tiff + 4, little);
        if (ifd + 2 > view.byteLength) return 1;
        const entries = view.getUint16(ifd, little);
        for (let i = 0; i < entries; i++) {
          const entry = ifd + 2 + i * 12;
          if (entry + 12 > view.byteLength) return 1;
          if (view.getUint16(entry, little) === 0x0112) {
            const value = view.getUint16(entry + 8, little);
            return value >= 1 && value <= 8 ? value : 1;
          }
        }
        return 1;
      }
    }
    if ((marker & 0xff00) !== 0xff00) return 1; // lost sync
    offset += 2 + size;
  }
  return 1;
}

/**
 * Decodes a JPEG through the browser (which applies EXIF orientation) and
 * re-encodes it upright, so the embedded image matches what the user sees.
 */
async function uprightJpegBytes(file: File): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.92),
    );
    if (!blob) throw new Error("toBlob failed");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

/**
 * Creates a PDF with one page per image, sized to each image.
 * Accepts JPEG and PNG. Output page count equals the number of images.
 * JPEGs with an EXIF orientation (phone photos) are normalized upright first —
 * pdf-lib embeds raw coded pixels and ignores EXIF, which would otherwise
 * produce sideways/upside-down pages.
 */
export async function jpgToPdf(images: File[]): Promise<ProcessedResult> {
  if (images.length < 1) {
    throw new PdfProcessingError("Please add at least one image.", "invalid_input");
  }

  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();

  for (const file of images) {
    let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
    let image;
    try {
      if (file.type === "image/png") {
        image = await doc.embedPng(bytes);
      } else if (file.type === "image/jpeg") {
        if (jpegExifOrientation(bytes) !== 1) {
          try {
            bytes = await uprightJpegBytes(file);
          } catch {
            // Normalization is best-effort; fall back to the raw bytes.
          }
        }
        image = await doc.embedJpg(bytes);
      } else {
        throw new PdfProcessingError(
          `"${file.name}" is not a supported image (JPG or PNG only).`,
          "unsupported_format",
        );
      }
    } catch (err) {
      if (err instanceof PdfProcessingError) throw err;
      throw new PdfProcessingError(
        `We couldn't process "${file.name}". It may be corrupted.`,
        "corrupt_document",
      );
    }

    const page = doc.addPage([image.width, image.height]);
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
    });
  }

  const out = await doc.save();
  return {
    blob: new Blob([out], { type: "application/pdf" }),
    fileName: "images.pdf",
    mimeType: "application/pdf",
  };
}
