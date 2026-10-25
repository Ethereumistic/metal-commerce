import type { SizeMode } from "./contracts";

export type SizeInput = {
  mode: SizeMode;
  width: number | null;
  height: number | null;
};

const round = (value: number) => Math.round(value * 100) / 100;
const positive = (value: number | null): value is number =>
  value != null && Number.isFinite(value) && value > 0;

/**
 * Physical size of a part from its master's aspect ratio (width / height).
 * Sizing is always aspect-locked: "width" and "height" derive the other side,
 * "fit" scales to the largest size inside width × height. Returns null until
 * the needed dimensions are entered. The service recomputes these exactly.
 */
export function actualSize(
  aspectRatio: number,
  size: SizeInput,
): { width: number; height: number } | null {
  if (!(aspectRatio > 0)) return null;
  if (size.mode === "width")
    return positive(size.width)
      ? { width: round(size.width), height: round(size.width / aspectRatio) }
      : null;
  if (size.mode === "height")
    return positive(size.height)
      ? { width: round(size.height * aspectRatio), height: round(size.height) }
      : null;
  if (!positive(size.width) || !positive(size.height)) return null;
  return size.width / size.height > aspectRatio
    ? { width: round(size.height * aspectRatio), height: round(size.height) }
    : { width: round(size.width), height: round(size.width / aspectRatio) };
}
