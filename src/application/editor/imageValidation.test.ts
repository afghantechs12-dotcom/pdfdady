import { describe, expect, it } from "vitest";
import {
  MAX_EDITOR_IMAGE_BYTES,
  MAX_EDITOR_IMAGE_SOURCE_LENGTH,
  safeImageDataUrl,
  validateImageDataUrl,
  validateImageDimensions,
} from "./imageValidation";

const png = "data:image/png;base64,AA==";
const jpeg = "data:image/jpeg;base64,AA==";

describe("editor image validation", () => {
  it("accepts bounded base64 PNG and JPEG sources", () => {
    expect(validateImageDataUrl(png).mime).toBe("image/png");
    expect(validateImageDataUrl(jpeg).mime).toBe("image/jpeg");
    expect(safeImageDataUrl(png)).toBe(png);
  });

  it("rejects active, remote, unsupported, and malformed sources", () => {
    for (const source of [
      "javascript:alert(1)",
      "https://example.com/image.png",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:image/gif;base64,AA==",
      "data:image/png,not-base64",
      "data:image/png;base64,%%",
    ]) {
      expect(safeImageDataUrl(source), source).toBeNull();
      expect(() => validateImageDataUrl(source), source).toThrow();
    }
  });

  it("enforces encoded and decoded resource bounds", () => {
    expect(() => validateImageDataUrl(`data:image/png;base64,${"A".repeat(MAX_EDITOR_IMAGE_SOURCE_LENGTH)}`)).toThrow();
    const overDecodedLimit = `data:image/png;base64,${"A".repeat(Math.ceil((MAX_EDITOR_IMAGE_BYTES + 1) / 3) * 4)}`;
    expect(() => validateImageDataUrl(overDecodedLimit)).toThrow();
  });

  it("requires finite positive bounded decoded dimensions", () => {
    expect(validateImageDimensions(1, 1)).toEqual({ width: 1, height: 1 });
    for (const [width, height] of [[0, 1], [1, -1], [Infinity, 1], [100_001, 1]]) {
      expect(() => validateImageDimensions(width, height)).toThrow();
    }
  });
});
