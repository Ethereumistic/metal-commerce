import { round, scaleLayer } from "./layout";
import type { Sheet, StudioDocument } from "./model";

// Grid nesting of identical pieces on a machine sheet. All values in mm.

export type Slot = { index: number; row: number; col: number; x: number; y: number };

export type Nest = {
  cols: number;
  rows: number;
  count: number;
  slots: Slot[];
  usable: { x: number; y: number; width: number; height: number };
  /** Space left inside the usable area after the grid. */
  leftover: { width: number; height: number };
  /** Share of the full sheet covered by pieces' bounding boxes. */
  utilisation: number;
};

// Tolerates float noise (e.g. 1404 / 468) without admitting a piece that does not fit.
const EPSILON = 1e-6;

function fit(available: number, size: number, spacing: number) {
  if (size <= 0 || available < size - EPSILON) return 0;
  return Math.floor((available + spacing + EPSILON) / (size + spacing));
}

export function nest(sheet: Sheet, piece: { width: number; height: number }): Nest {
  const usable = {
    x: sheet.margin,
    y: sheet.margin,
    width: Math.max(0, sheet.width - sheet.margin * 2),
    height: Math.max(0, sheet.height - sheet.margin * 2),
  };
  const cols = fit(usable.width, piece.width, sheet.spacing);
  const rows = fit(usable.height, piece.height, sheet.spacing);
  const gridWidth = cols ? cols * piece.width + (cols - 1) * sheet.spacing : 0;
  const gridHeight = rows ? rows * piece.height + (rows - 1) * sheet.spacing : 0;
  const leftover = {
    width: round(usable.width - gridWidth),
    height: round(usable.height - gridHeight),
  };
  const x0 = usable.x + (sheet.anchor === "center" ? leftover.width / 2 : 0);
  const y0 =
    usable.y +
    (sheet.anchor === "bottom-left"
      ? leftover.height
      : sheet.anchor === "center"
        ? leftover.height / 2
        : 0);

  const slots: Slot[] = [];
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++)
      slots.push({
        index: slots.length,
        row,
        col,
        x: round(x0 + col * (piece.width + sheet.spacing)),
        y: round(y0 + row * (piece.height + sheet.spacing)),
      });

  const count = cols * rows;
  return {
    cols,
    rows,
    count,
    slots,
    usable,
    leftover,
    utilisation:
      sheet.width && sheet.height
        ? (count * piece.width * piece.height) / (sheet.width * sheet.height)
        : 0,
  };
}

/** Largest piece side that fits `cols` columns across the usable width. */
export function sizeForColumns(sheet: Sheet, cols: number) {
  const usable = sheet.width - sheet.margin * 2;
  return round((usable - (cols - 1) * sheet.spacing) / cols);
}

/**
 * Resizes the product (artboard). With `scaleArtwork`, layers, padding and
 * corner radius scale uniformly about the centre so the design keeps its look.
 */
export function resizeProduct(
  doc: StudioDocument,
  width: number,
  height: number,
  scaleArtwork: boolean,
) {
  const { artboard } = doc;
  if (width <= 0 || height <= 0) return;
  if (scaleArtwork && artboard.width > 0 && artboard.height > 0) {
    const factor = Math.min(width / artboard.width, height / artboard.height);
    for (const layer of doc.layers) {
      layer.x = round(width / 2 + (layer.x - artboard.width / 2) * factor);
      layer.y = round(height / 2 + (layer.y - artboard.height / 2) * factor);
      scaleLayer(layer, factor);
    }
    artboard.padding = round(artboard.padding * factor);
    artboard.cornerRadius = round(artboard.cornerRadius * factor);
  } else {
    for (const layer of doc.layers) {
      layer.x = round(layer.x + (width - artboard.width) / 2);
      layer.y = round(layer.y + (height - artboard.height) / 2);
    }
  }
  artboard.width = round(width);
  artboard.height = round(height);
}
