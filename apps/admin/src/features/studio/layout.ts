import { layerBox, layerSize, type Rect, type Resolved } from "./geometry";
import type { Artboard, Layer } from "./model";

// Pure layout operations. All positions refer to visible bounds, so "centred"
// means the painted artwork is centred — not an arbitrary source viewBox.

/** Uniformly scales a layer's visible size by `factor`, keeping its centre. */
export function scaleLayer(layer: Layer, factor: number) {
  if (!Number.isFinite(factor) || factor <= 0) return;
  if (layer.kind === "asset") layer.size = round(layer.size * factor);
  if (layer.kind === "text") {
    layer.fontSize = round(layer.fontSize * factor);
    layer.arc = round(layer.arc * factor);
  }
  if (layer.kind === "shape") {
    layer.width = round(layer.width * factor);
    layer.height = round(layer.height * factor);
    layer.cornerRadius = round(layer.cornerRadius * factor);
  }
}

export function artboardRect(artboard: Artboard): Rect {
  return { x: 0, y: 0, width: artboard.width, height: artboard.height };
}

/** Largest uniform scale factor that fits the layer inside the artboard's safe area. */
export function fitFactor(layer: Layer, resolved: Resolved, artboard: Artboard, padding: number) {
  const box = layerBox(layer, resolved);
  if (!box.width || !box.height) return 1;
  const availableW = artboard.width - padding * 2;
  const availableH = artboard.height - padding * 2;
  if (availableW <= 0 || availableH <= 0) return 1;
  if (artboard.shape === "ellipse") {
    // Keep the box's corners inside the inset ellipse.
    const a = availableW / 2;
    const b = availableH / 2;
    return 1 / Math.sqrt((box.width / 2 / a) ** 2 + (box.height / 2 / b) ** 2);
  }
  return Math.min(availableW / box.width, availableH / box.height);
}

export function fitLayer(layer: Layer, resolved: Resolved, artboard: Artboard, padding: number) {
  scaleLayer(layer, fitFactor(layer, resolved, artboard, padding));
  layer.x = artboard.width / 2;
  layer.y = artboard.height / 2;
}

export type Edge = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/** Aligns the layer's visible box to `target`, inset by `margin` for outer edges. */
export function alignLayer(
  layer: Layer,
  resolved: Resolved,
  target: Rect,
  edge: Edge,
  margin: number,
) {
  const box = layerBox(layer, resolved);
  const halfW = box.width / 2;
  const halfH = box.height / 2;
  if (edge === "left") layer.x = round(target.x + margin + halfW);
  if (edge === "hcenter") layer.x = round(target.x + target.width / 2);
  if (edge === "right") layer.x = round(target.x + target.width - margin - halfW);
  if (edge === "top") layer.y = round(target.y + margin + halfH);
  if (edge === "vcenter") layer.y = round(target.y + target.height / 2);
  if (edge === "bottom") layer.y = round(target.y + target.height - margin - halfH);
}

/** Scales the layer so its longest visible side equals the other layer's. */
export function matchSize(layer: Layer, resolved: Resolved, other: Resolved) {
  const own = layerSize(resolved);
  const theirs = layerSize(other);
  const ownLongest = Math.max(own.width, own.height);
  const theirLongest = Math.max(theirs.width, theirs.height);
  if (ownLongest > 0) scaleLayer(layer, theirLongest / ownLongest);
}

// ---------------------------------------------------------------------------
// Snapping

export type Guide = { axis: "x" | "y"; value: number };

export type SnapTargets = { x: number[]; y: number[] };

export function snapTargets(
  artboard: Artboard,
  others: Rect[],
): SnapTargets {
  const x = [0, artboard.width / 2, artboard.width];
  const y = [0, artboard.height / 2, artboard.height];
  if (artboard.padding > 0) {
    x.push(artboard.padding, artboard.width - artboard.padding);
    y.push(artboard.padding, artboard.height - artboard.padding);
  }
  for (const box of others) {
    x.push(box.x, box.x + box.width / 2, box.x + box.width);
    y.push(box.y, box.y + box.height / 2, box.y + box.height);
  }
  return { x, y };
}

function snapAxis(edges: number[], targets: number[], threshold: number) {
  let best: { delta: number; value: number } | null = null;
  for (const edge of edges)
    for (const target of targets) {
      const delta = target - edge;
      if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta)))
        best = { delta, value: target };
    }
  return best;
}

/** Snaps a box's edges and centre to the nearest targets within `threshold`. */
export function snapBox(box: Rect, targets: SnapTargets, threshold: number) {
  const sx = snapAxis([box.x, box.x + box.width / 2, box.x + box.width], targets.x, threshold);
  const sy = snapAxis([box.y, box.y + box.height / 2, box.y + box.height], targets.y, threshold);
  const guides: Guide[] = [];
  if (sx) guides.push({ axis: "x", value: sx.value });
  if (sy) guides.push({ axis: "y", value: sy.value });
  return { dx: sx?.delta ?? 0, dy: sy?.delta ?? 0, guides };
}

export function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
