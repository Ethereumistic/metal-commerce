import { getLoadedFont, layoutText } from "./fonts";
import { libraryAsset, uploadAsset } from "./library";
import type {
  Artboard,
  AssetLayer,
  Layer,
  ShapeLayer,
  StudioDocument,
  TextLayer,
} from "./model";
import { SIGN_DATES, SIGN_LABELS, type Sign } from "./signs";
import { attributesToString, type ParsedSvg } from "./svg";

export type Rect = { x: number; y: number; width: number; height: number };

/** A layer reduced to drawable markup plus the bounds of what is actually painted. */
export type Resolved = {
  markup: string;
  /** Visible bounds in content units (strokes included). */
  bounds: Rect;
  /** Uniform content → artboard scale. */
  scale: number;
  warning?: string;
};

const EMPTY: Rect = { x: 0, y: 0, width: 0, height: 0 };

// ---------------------------------------------------------------------------
// Visible-bounds measurement for SVG fragments, using the browser's geometry.

let measureRoot: SVGSVGElement | null = null;
const measured = new Map<string, Rect>();

function measureMarkup(key: string, wrapper: string): Rect {
  const cached = measured.get(key);
  if (cached) return cached;
  if (typeof document === "undefined") return EMPTY;
  if (!measureRoot) {
    measureRoot = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    measureRoot.setAttribute("aria-hidden", "true");
    // getBBox needs a rendered (not display:none) element.
    Object.assign(measureRoot.style, {
      position: "fixed",
      left: "-10000px",
      top: "0",
      width: "1px",
      height: "1px",
      visibility: "hidden",
      pointerEvents: "none",
    });
    document.body.appendChild(measureRoot);
  }
  measureRoot.innerHTML = wrapper;
  const group = measureRoot.firstElementChild as SVGGraphicsElement | null;
  const box = group?.getBBox();
  measureRoot.innerHTML = "";
  const rect = box
    ? { x: box.x, y: box.y, width: box.width, height: box.height }
    : EMPTY;
  measured.set(key, rect);
  return rect;
}

function assetMarkup(asset: ParsedSvg, strokeWidth: number | null) {
  const attributes = { ...asset.attributes };
  if (strokeWidth != null && asset.stroked) attributes["stroke-width"] = String(strokeWidth);
  return `<g${attributesToString(attributes)}>${asset.markup}</g>`;
}

function effectiveStroke(asset: ParsedSvg, override: number | null) {
  if (!asset.stroked) return 0;
  return override ?? asset.strokeWidth ?? 1;
}

// ---------------------------------------------------------------------------

export function assetFor(layer: AssetLayer, doc: Pick<StudioDocument, "sign" | "uploads">, sign?: Sign) {
  const source = layer.source;
  if (source.type === "library")
    return libraryAsset(source.set, source.followDocument ? (sign ?? doc.sign) : source.sign);
  const upload = doc.uploads[source.uploadId];
  return upload ? uploadAsset(upload.id, upload.svg) : null;
}

export function resolveText(text: string, sign: Sign, transform: TextLayer["transform"]) {
  const value = text
    .replaceAll("{sign}", SIGN_LABELS[sign])
    .replaceAll("{dates}", SIGN_DATES[sign]);
  if (transform === "uppercase") return value.toLocaleUpperCase();
  if (transform === "lowercase") return value.toLocaleLowerCase();
  return value;
}

const resolvedCache = new Map<string, Resolved | null>();

function cached(key: string, build: () => Resolved | null) {
  if (resolvedCache.has(key)) return resolvedCache.get(key)!;
  const value = build();
  if (resolvedCache.size > 800) resolvedCache.clear();
  resolvedCache.set(key, value);
  return value;
}

function resolveAsset(layer: AssetLayer, doc: StudioDocument, sign: Sign): Resolved | null {
  let asset: ParsedSvg | null;
  try {
    asset = assetFor(layer, doc, sign);
  } catch {
    return null;
  }
  if (!asset) return null;
  const parsed = asset;
  const sourceKey =
    layer.source.type === "library"
      ? `${layer.source.set}:${layer.source.followDocument ? sign : layer.source.sign}`
      : `upload:${layer.source.uploadId}:${doc.uploads[layer.source.uploadId]?.svg.length}`;
  const key = `asset|${sourceKey}|${layer.strokeWidth}`;
  const base = cached(key, () => {
    const markup = assetMarkup(parsed, layer.strokeWidth);
    const geometry = measureMarkup(key, markup);
    if (!geometry.width && !geometry.height) return null;
    const pad = effectiveStroke(parsed, layer.strokeWidth) / 2;
    return {
      markup,
      bounds: {
        x: geometry.x - pad,
        y: geometry.y - pad,
        width: geometry.width + pad * 2,
        height: geometry.height + pad * 2,
      },
      scale: 1,
    };
  });
  if (!base) return null;
  const longest = Math.max(base.bounds.width, base.bounds.height);
  return { ...base, scale: longest > 0 ? layer.size / longest : 1 };
}

function resolveTextLayer(layer: TextLayer, sign: Sign): Resolved | null {
  const font = getLoadedFont(layer.font);
  if (!font) return null;
  const text = resolveText(layer.text, sign, layer.transform);
  const key = `text|${layer.font.id}/${layer.font.subset}/${layer.font.weight}/${layer.font.style}|${layer.fontSize}|${layer.letterSpacing}|${layer.kerning}|${layer.arc}|${text}`;
  return cached(key, () => {
    const outline = layoutText(font, text, layer);
    if (!outline) return null;
    return {
      markup: `<path fill="currentColor" d="${outline.d}"/>`,
      bounds: outline.bounds,
      scale: 1,
      warning: outline.missing.length
        ? `Font has no glyphs for: ${outline.missing.join(" ")}`
        : undefined,
    };
  });
}

function resolveShape(layer: ShapeLayer): Resolved | null {
  const { width, height } = layer;
  if (width <= 0 || height <= 0) return null;
  const stroke = layer.fill ? 0 : Math.min(layer.strokeWidth, width / 2, height / 2);
  const inset = stroke / 2;
  const w = width - stroke;
  const h = height - stroke;
  const paint = layer.fill
    ? `fill="currentColor"`
    : `fill="none" stroke="currentColor" stroke-width="${stroke}"`;
  const markup =
    layer.shape === "ellipse"
      ? `<ellipse cx="${width / 2}" cy="${height / 2}" rx="${w / 2}" ry="${h / 2}" ${paint}/>`
      : `<rect x="${inset}" y="${inset}" width="${w}" height="${h}" rx="${Math.max(0, layer.cornerRadius - inset)}" ${paint}/>`;
  return { markup, bounds: { x: 0, y: 0, width, height }, scale: 1 };
}

export function resolveLayer(layer: Layer, doc: StudioDocument, sign: Sign = doc.sign) {
  if (layer.kind === "asset") return resolveAsset(layer, doc, sign);
  if (layer.kind === "text") return resolveTextLayer(layer, sign);
  return resolveShape(layer);
}

/** Maps content coordinates so the visible-bounds centre lands on (x, y). */
export function layerTransform(layer: Layer, resolved: Resolved) {
  const cx = resolved.bounds.x + resolved.bounds.width / 2;
  const cy = resolved.bounds.y + resolved.bounds.height / 2;
  const sx = resolved.scale * (layer.flipX ? -1 : 1);
  const sy = resolved.scale * (layer.flipY ? -1 : 1);
  const parts = [`translate(${round(layer.x)} ${round(layer.y)})`];
  if (layer.rotation) parts.push(`rotate(${round(layer.rotation)})`);
  parts.push(`scale(${round(sx)} ${round(sy)})`);
  parts.push(`translate(${round(-cx)} ${round(-cy)})`);
  return parts.join(" ");
}

/** Size of the visible bounds in artboard units (before rotation). */
export function layerSize(resolved: Resolved) {
  return {
    width: resolved.bounds.width * resolved.scale,
    height: resolved.bounds.height * resolved.scale,
  };
}

/** Axis-aligned box of the (possibly rotated) layer, in artboard units. */
export function layerBox(layer: Layer, resolved: Resolved): Rect {
  const { width, height } = layerSize(resolved);
  const angle = (layer.rotation * Math.PI) / 180;
  const w = Math.abs(width * Math.cos(angle)) + Math.abs(height * Math.sin(angle));
  const h = Math.abs(width * Math.sin(angle)) + Math.abs(height * Math.cos(angle));
  return { x: layer.x - w / 2, y: layer.y - h / 2, width: w, height: h };
}

export function round(value: number) {
  return Math.round(value * 10000) / 10000;
}

export function artboardShapeMarkup(artboard: Artboard, attributes: string) {
  const { width, height } = artboard;
  return artboard.shape === "ellipse"
    ? `<ellipse cx="${width / 2}" cy="${height / 2}" rx="${width / 2}" ry="${height / 2}"${attributes}/>`
    : `<rect width="${width}" height="${height}" rx="${Math.min(artboard.cornerRadius, width / 2, height / 2)}"${attributes}/>`;
}
