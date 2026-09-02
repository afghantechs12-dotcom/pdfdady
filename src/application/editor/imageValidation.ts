import { MAX_NATURAL_IMAGE_DIMENSION } from "@/src/application/editor/tools/cropMath";

export const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg"] as const;
export type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

/** Upper bound applied before FileReader, editor history, serialization, and export. */
export const MAX_EDITOR_IMAGE_BYTES = 10 * 1024 * 1024;
/** Base64 adds roughly 4/3 plus a small data-URL header. */
export const MAX_EDITOR_IMAGE_SOURCE_LENGTH = Math.ceil((MAX_EDITOR_IMAGE_BYTES * 4) / 3) + 128;

export interface ValidatedImageDataUrl {
  source: string;
  mime: SupportedImageMimeType;
  bytes: Uint8Array;
}

function isSupportedMime(value: string): value is SupportedImageMimeType {
  return SUPPORTED_IMAGE_MIME_TYPES.includes(value as SupportedImageMimeType);
}

const IMAGE_DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]*={0,2})$/i;

/**
 * Lightweight render-boundary allowlist. Upload/deserialization/export use the
 * full validator below; SVG renderers use this shape check to avoid repeatedly
 * decoding a potentially multi-megabyte payload merely to decide whether it is
 * safe to bind to an image href.
 */
export function safeImageDataUrl(source: unknown): string | null {
  if (
    typeof source !== "string" ||
    source.length === 0 ||
    source.length > MAX_EDITOR_IMAGE_SOURCE_LENGTH ||
    !IMAGE_DATA_URL_PATTERN.test(source)
  ) {
    return null;
  }
  return source;
}

export function validateImageDataUrl(source: unknown): ValidatedImageDataUrl {
  const safeSource = safeImageDataUrl(source);
  if (!safeSource) {
    throw new Error("Only bounded base64 PNG and JPEG data URLs are supported.");
  }
  const match = IMAGE_DATA_URL_PATTERN.exec(safeSource);
  if (!match) {
    throw new Error("Only base64 PNG and JPEG data URLs are supported.");
  }
  const mime = match[1].toLowerCase();
  if (!isSupportedMime(mime)) throw new Error("Unsupported image MIME type.");
  let binary: string;
  try {
    binary = atob(match[2]);
  } catch {
    throw new Error("Malformed image data URL.");
  }
  if (binary.length === 0 || binary.length > MAX_EDITOR_IMAGE_BYTES) {
    throw new Error("Image data is empty or exceeds the editor image limit.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { source: safeSource, mime, bytes };
}

export function validateImageDimensions(width: unknown, height: unknown): { width: number; height: number } {
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_NATURAL_IMAGE_DIMENSION ||
    height > MAX_NATURAL_IMAGE_DIMENSION
  ) {
    throw new Error(`Image dimensions must be positive and no larger than ${MAX_NATURAL_IMAGE_DIMENSION}px.`);
  }
  return { width, height };
}

export function validateImageFile(file: Pick<File, "type" | "size">): SupportedImageMimeType {
  if (!isSupportedMime(file.type)) throw new Error("Choose a PNG or JPEG image.");
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_EDITOR_IMAGE_BYTES) {
    throw new Error(`Image must be smaller than ${Math.floor(MAX_EDITOR_IMAGE_BYTES / (1024 * 1024))} MB.`);
  }
  return file.type;
}

export function readImageFileAsDataUrl(file: File): Promise<string> {
  validateImageFile(file);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(validateImageDataUrl(reader.result).source);
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(new Error("Failed to read image file."));
    reader.readAsDataURL(file);
  });
}

export function decodeImageDimensions(source: string): Promise<{ width: number; height: number }> {
  validateImageDataUrl(source);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        resolve(validateImageDimensions(image.naturalWidth, image.naturalHeight));
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = () => reject(new Error("The selected image could not be decoded."));
    image.src = source;
  });
}
