import type { EditorObject, ImageObject } from "@/src/domain/editor/objects";
import { isObjectKind } from "@/src/domain/editor/objects";
import { isInvertibleTransform } from "@/src/domain/editor/geometry";
import { MAX_NATURAL_IMAGE_DIMENSION } from "./cropMath";

export interface CropEligibility {
  available: boolean;
  reason?: string;
  image?: ImageObject;
}

/** Canonical crop availability used by toolbar, shortcuts, menu, and canvas. */
export function resolveCropEligibility(selected: readonly EditorObject[]): CropEligibility {
  if (selected.length !== 1 || !isObjectKind(selected[0], "image")) {
    return { available: false, reason: "Select one image to crop" };
  }
  const image = selected[0];
  if (!image.visible) return { available: false, reason: "Show the image to crop it" };
  if (image.locked) return { available: false, reason: "Unlock the image to crop" };
  if (
    !Number.isFinite(image.naturalWidth) ||
    !Number.isFinite(image.naturalHeight) ||
    image.naturalWidth <= 0 ||
    image.naturalHeight <= 0 ||
    image.naturalWidth > MAX_NATURAL_IMAGE_DIMENSION ||
    image.naturalHeight > MAX_NATURAL_IMAGE_DIMENSION
  ) {
    return { available: false, reason: "This image has invalid dimensions" };
  }
  if (!isInvertibleTransform(image.transform)) {
    return {
      available: false,
      reason: "This image cannot be cropped because its transform is singular",
    };
  }
  return { available: true, image };
}
