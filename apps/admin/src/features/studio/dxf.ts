import * as ClipperNamespace from "clipper-lib";
import svgpath from "svgpath";
import { DxfWriter, LWPolylineFlags, Units, point2d, point3d } from "@tarikjabiri/dxf";
import { getLoadedFont } from "./fonts";
import type { Artboard, Bridges, Layer, StudioDocument } from "./model";
import { layerMarkup } from "./geometry";
import { nest } from "./sheet";
import type { Sign } from "./signs";

// DXF for laser cutting. A laser follows closed contours, so the artwork is
// converted to the outlines of what is painted:
//   1. every SVG element is flattened to polylines (curves within `tolerance`),
//   2. strokes become the outline of the stroke (caps and joins included),
//   3. fills are normalised with their fill rule,
//   4. layers are merged (union) so overlaps are cut once; a layer painted in
//      the product's background colour cuts back into what is below it,
//   5. the result is clipped to the product when "clip to shape" is on.
// Coordinates are written in the design unit (mm) with the Y axis up.

// clipper-lib is CommonJS; bundlers expose it either as the namespace or `default`.
const ClipperLib = ((ClipperNamespace as unknown as { default?: typeof ClipperNamespace }).default ??
  ClipperNamespace) as typeof ClipperNamespace;

type Point = { x: number; y: number };
type Ring = Point[];
type IntPaths = ClipperNamespace.Paths;

/** Clipper works in integers: 1 unit = 0.1 µm. */
const SCALE = 10_000;

export type DxfOptions = {
  /** Maximum distance between a curve and its polyline, in design units. */
  tolerance: number;
};

export type SheetDxfOptions = DxfOptions & {
  /** Merge shared straight piece edges into single lines (gap 0). */
  commonLine: boolean;
  /** Add the sheet edge and safety margin on the non-cutting SHEET layer. */
  reference: boolean;
  /** Include artwork openings; off writes piece outlines only. */
  artwork: boolean;
};

/**
 * The workshop's laser cuts everything on layer 0 (always present in a DXF).
 * The sheet edge and safety margin are reference only, on SHEET in AutoCAD
 * colour index 4 (standard cyan / light blue).
 */
export const LAYERS = {
  cut: { name: "0" },
  sheet: { name: "SHEET", color: 4 },
} as const;

// ---------------------------------------------------------------------------
// Flattening

function flattenCubic(
  out: Ring,
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  tolerance: number,
  depth = 0,
) {
  // Flat enough when the control points are close to the chord.
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const d1 = Math.abs((p1.x - p3.x) * dy - (p1.y - p3.y) * dx);
  const d2 = Math.abs((p2.x - p3.x) * dy - (p2.y - p3.y) * dx);
  const chord = dx * dx + dy * dy;
  if (depth > 18 || (d1 + d2) ** 2 <= tolerance * tolerance * 16 * Math.max(chord, 1e-12)) {
    out.push(p3);
    return;
  }
  const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const p01 = mid(p0, p1);
  const p12 = mid(p1, p2);
  const p23 = mid(p2, p3);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const centre = mid(p012, p123);
  flattenCubic(out, p0, p01, p012, centre, tolerance, depth + 1);
  flattenCubic(out, centre, p123, p23, p3, tolerance, depth + 1);
}

type Subpath = { points: Ring; closed: boolean };

/** Flattens SVG path data (after `matrix`) into polylines. */
function flattenPath(d: string, matrix: number[], tolerance: number): Subpath[] {
  const subpaths: Subpath[] = [];
  let current = null as Subpath | null;
  let start: Point = { x: 0, y: 0 };
  svgpath(d)
    .matrix(matrix)
    .abs()
    .unarc()
    .unshort()
    .iterate((segment, _index, x, y) => {
      const command = segment[0];
      if (command === "M") {
        start = { x: segment[1] as number, y: segment[2] as number };
        current = { points: [start], closed: false };
        subpaths.push(current);
        return;
      }
      if (!current) {
        current = { points: [{ x, y }], closed: false };
        subpaths.push(current);
      }
      const points = current.points;
      switch (command) {
        case "L":
          points.push({ x: segment[1] as number, y: segment[2] as number });
          break;
        case "H":
          points.push({ x: segment[1] as number, y });
          break;
        case "V":
          points.push({ x, y: segment[1] as number });
          break;
        case "C": {
          const [, x1, y1, x2, y2, x3, y3] = segment as number[] as [never, number, number, number, number, number, number];
          flattenCubic(points, { x, y }, { x: x1, y: y1 }, { x: x2, y: y2 }, { x: x3, y: y3 }, tolerance);
          break;
        }
        case "Q": {
          // Elevate the quadratic to a cubic.
          const [, qx, qy, x3, y3] = segment as number[] as [never, number, number, number, number];
          flattenCubic(
            points,
            { x, y },
            { x: x + ((qx - x) * 2) / 3, y: y + ((qy - y) * 2) / 3 },
            { x: x3 + ((qx - x3) * 2) / 3, y: y3 + ((qy - y3) * 2) / 3 },
            { x: x3, y: y3 },
            tolerance,
          );
          break;
        }
        case "Z":
        case "z":
          current.closed = true;
          // A drawing command after Z (without M) starts a new subpath at the start point.
          current = null;
          break;
      }
    });
  // A lone moveto paints nothing; zero-length segments ("M x y l0 0") keep two points.
  return subpaths.filter((subpath) => subpath.points.length > 1);
}

function number(value: string | null) {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Path data for basic shapes, in the element's own coordinates. */
function elementPathData(element: Element): string | null {
  const a = (name: string) => number(element.getAttribute(name));
  switch (element.localName) {
    case "path":
      return element.getAttribute("d");
    case "rect": {
      const [x, y, w, h] = [a("x"), a("y"), a("width"), a("height")];
      if (w <= 0 || h <= 0) return null;
      let rx = element.hasAttribute("rx") ? a("rx") : a("ry");
      let ry = element.hasAttribute("ry") ? a("ry") : rx;
      rx = Math.min(Math.max(rx, 0), w / 2);
      ry = Math.min(Math.max(ry, 0), h / 2);
      if (!rx || !ry) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
    }
    case "circle":
    case "ellipse": {
      const cx = a("cx");
      const cy = a("cy");
      const rx = element.localName === "circle" ? a("r") : a("rx");
      const ry = element.localName === "circle" ? a("r") : a("ry");
      if (rx <= 0 || ry <= 0) return null;
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    case "line":
      return `M${a("x1")} ${a("y1")}L${a("x2")} ${a("y2")}`;
    case "polyline":
    case "polygon": {
      const values = (element.getAttribute("points") ?? "").trim().split(/[\s,]+/).map(Number);
      if (values.length < 4 || values.some((value) => !Number.isFinite(value))) return null;
      let d = `M${values[0]} ${values[1]}`;
      for (let i = 2; i + 1 < values.length; i += 2) d += `L${values[i]} ${values[i + 1]}`;
      return element.localName === "polygon" ? `${d}Z` : d;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Clipper helpers

const toInt = (ring: Ring) => ring.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
const fromInt = (paths: IntPaths): Ring[] =>
  paths.map((path) => path.map((p) => ({ x: p.X / SCALE, y: p.Y / SCALE })));

function boolean(
  type: ClipperNamespace.ClipType,
  subject: IntPaths,
  clip: IntPaths,
  fill: ClipperNamespace.PolyFillType = ClipperLib.PolyFillType.pftNonZero,
) {
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  if (clip.length) clipper.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
  const solution: IntPaths = [];
  clipper.Execute(type, solution, fill, ClipperLib.PolyFillType.pftNonZero);
  return solution;
}

const union = (paths: IntPaths, fill?: ClipperNamespace.PolyFillType) =>
  boolean(ClipperLib.ClipType.ctUnion, paths, [], fill);

// ---------------------------------------------------------------------------
// Geometry extraction from rendered SVG

let host: SVGSVGElement | null = null;

function renderHost() {
  if (!host) {
    host = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    host.setAttribute("aria-hidden", "true");
    Object.assign(host.style, {
      position: "fixed",
      left: "-10000px",
      top: "0",
      width: "1px",
      height: "1px",
      // Not visibility:hidden — children inherit it and would look unpainted.
      opacity: "0",
      pointerEvents: "none",
    });
    document.body.appendChild(host);
  }
  return host;
}

const GEOMETRY = "path, rect, circle, ellipse, line, polyline, polygon";

/** Painted area of one layer as integer polygons. */
function layerArea(markup: string, tolerance: number): IntPaths {
  const svg = renderHost();
  svg.innerHTML = markup;
  const areas: IntPaths = [];
  try {
    for (const element of Array.from(svg.querySelectorAll(GEOMETRY))) {
      if (element.closest("defs, clipPath, mask, symbol")) continue;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const d = elementPathData(element);
      const ctm = (element as SVGGraphicsElement).getCTM();
      if (!d || !ctm) continue;
      const matrix = [ctm.a, ctm.b, ctm.c, ctm.d, ctm.e, ctm.f];
      const subpaths = flattenPath(d, matrix, tolerance);

      if (style.fill !== "none" && Number(style.fillOpacity) !== 0) {
        const rings = subpaths.filter((s) => s.points.length > 2).map((s) => toInt(s.points));
        if (rings.length)
          areas.push(
            ...union(
              rings,
              style.fillRule === "evenodd"
                ? ClipperLib.PolyFillType.pftEvenOdd
                : ClipperLib.PolyFillType.pftNonZero,
            ),
          );
      }

      const width = number(style.strokeWidth) * Math.sqrt(Math.abs(ctm.a * ctm.d - ctm.b * ctm.c));
      if (style.stroke !== "none" && Number(style.strokeOpacity) !== 0 && width > 0) {
        const join =
          style.strokeLinejoin === "round"
            ? ClipperLib.JoinType.jtRound
            : style.strokeLinejoin === "bevel"
              ? ClipperLib.JoinType.jtSquare
              : ClipperLib.JoinType.jtMiter;
        const cap =
          style.strokeLinecap === "round"
            ? ClipperLib.EndType.etOpenRound
            : style.strokeLinecap === "square"
              ? ClipperLib.EndType.etOpenSquare
              : ClipperLib.EndType.etOpenButt;
        const offset = new ClipperLib.ClipperOffset(
          number(style.strokeMiterlimit) || 4,
          tolerance * SCALE,
        );
        for (const subpath of subpaths)
          offset.AddPath(
            toInt(subpath.points),
            join,
            subpath.closed ? ClipperLib.EndType.etClosedLine : cap,
          );
        const outline: IntPaths = [];
        offset.Execute(outline, (width / 2) * SCALE);
        areas.push(...outline);
      }
    }
  } finally {
    svg.innerHTML = "";
  }
  return union(areas);
}

function sameColour(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function artboardShape(artboard: Artboard, tolerance: number): IntPaths {
  const { width, height } = artboard;
  const d =
    artboard.shape === "ellipse"
      ? `M0 ${height / 2}A${width / 2} ${height / 2} 0 1 0 ${width} ${height / 2}A${width / 2} ${height / 2} 0 1 0 0 ${height / 2}Z`
      : (elementPathDataFromRect(width, height, Math.min(artboard.cornerRadius, width / 2, height / 2)));
  return flattenPath(d, [1, 0, 0, 1, 0, 0], tolerance)
    .filter((s) => s.points.length > 2)
    .map((s) => toInt(s.points));
}

function elementPathDataFromRect(w: number, h: number, r: number) {
  if (!r) return `M0 0H${w}V${h}H0Z`;
  return `M${r} 0H${w - r}A${r} ${r} 0 0 1 ${w} ${r}V${h - r}A${r} ${r} 0 0 1 ${w - r} ${h}H${r}A${r} ${r} 0 0 1 0 ${h - r}V${r}A${r} ${r} 0 0 1 ${r} 0Z`;
}

/** Openings (the areas the laser removes) as integer polygons, before bridging. */
function openings(doc: StudioDocument, sign: Sign, tolerance: number): IntPaths {
  let result: IntPaths = [];
  for (const layer of doc.layers as Layer[]) {
    if (!layer.visible || layer.opacity === 0) continue;
    const markup = layerMarkup(doc, layer, sign);
    if (!markup) continue;
    const area = layerArea(markup, tolerance);
    if (!area.length) continue;
    // Artwork in the metal's own colour removes material from what is below it.
    result = sameColour(layer.color, doc.artboard.background)
      ? boolean(ClipperLib.ClipType.ctDifference, result, area)
      : union([...result, ...area]);
  }
  if (doc.artboard.clip && result.length)
    result = boolean(ClipperLib.ClipType.ctIntersection, result, artboardShape(doc.artboard, tolerance));
  return result;
}

// ---------------------------------------------------------------------------
// Bridges

/** Crossings (t > 0, and which ring) of the ray P + t·d with the edges of `rings`. */
function rayHits(rings: Ring[], p: Point, d: Point) {
  const hits: { t: number; ring: number }[] = [];
  rings.forEach((ring, index) => {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const denom = d.x * ey - d.y * ex;
      if (Math.abs(denom) < 1e-12) continue;
      const ax = a.x - p.x;
      const ay = a.y - p.y;
      const t = (ax * ey - ay * ex) / denom;
      const u = (ax * d.y - ay * d.x) / denom;
      if (t > 1e-9 && u >= 0 && u < 1) hits.push({ t, ring: index });
    }
  });
  return hits.sort((x, y) => x.t - y.t);
}

/** A point strictly inside a simple polygon (the middle of its widest horizontal span). */
function interiorPoint(ring: Ring): Point {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  let best: Point = ring[0]!;
  let bestSpan = -1;
  for (let k = 1; k < 16; k++) {
    const y = minY + ((maxY - minY) * k) / 16;
    const xs: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y))
        xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const span = xs[i + 1]! - xs[i]!;
      if (span > bestSpan) {
        bestSpan = span;
        best = { x: (xs[i]! + xs[i + 1]!) / 2, y };
      }
    }
  }
  return best;
}

type Candidate = { d: Point; start: number; end: number; length: number };

function directions(mode: Bridges["direction"]): Point[] {
  if (mode === "vertical") return [{ x: 0, y: -1 }, { x: 0, y: 1 }];
  if (mode === "horizontal") return [{ x: -1, y: 0 }, { x: 1, y: 0 }];
  return Array.from({ length: 24 }, (_, k) => ({
    x: Math.cos((k * Math.PI) / 12),
    y: Math.sin((k * Math.PI) / 12),
  }));
}

/**
 * Bridge strips for every island. An island is a hole in an opening (metal
 * enclosed by a cut). From a point inside it, a ray crosses the opening and
 * re-enters metal; that span, `width` wide, is kept as metal.
 */
function bridgeStrips(paths: IntPaths, settings: Bridges) {
  const tree = new ClipperLib.PolyTree();
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    tree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  );
  const strips: Ring[] = [];
  let islands = 0;
  const overlap = 0.05; // reach slightly into metal on both ends

  const visit = (node: ClipperNamespace.PolyNode) => {
    for (const child of node.Childs()) {
      if (child.IsHole()) {
        islands++;
        const opening = node; // the outer contour this hole sits in
        const siblings = opening.Childs();
        const rings = [opening.Contour(), ...siblings.map((c) => c.Contour())].map(
          (path) => fromInt([path])[0]!,
        );
        const own = siblings.indexOf(child) + 1;
        const hole = fromInt([child.Contour()])[0]!;
        const p = interiorPoint(hole);
        const candidates: Candidate[] = [];
        for (const d of directions(settings.direction)) {
          const hits = rayHits(rings, p, d);
          // First crossing leaves the island; the bridge runs until the ray meets
          // *other* metal (outer edge or another island), so a non-convex island
          // is never only bridged to itself.
          const exit = hits[0];
          const reach = hits.find((hit) => hit.ring !== own);
          if (exit && reach)
            candidates.push({ d, start: exit.t, end: reach.t, length: reach.t - exit.t });
        }
        candidates.sort((a, b) => a.length - b.length);
        const chosen: Candidate[] = [];
        for (const candidate of candidates) {
          if (chosen.length >= settings.perIsland) break;
          // A second bridge goes roughly opposite the first (at least 90° away).
          if (chosen.some((c) => c.d.x * candidate.d.x + c.d.y * candidate.d.y > 1e-6)) continue;
          chosen.push(candidate);
        }
        for (const { d, start, end } of chosen) {
          const n = { x: -d.y * (settings.width / 2), y: d.x * (settings.width / 2) };
          const a = { x: p.x + d.x * (start - overlap), y: p.y + d.y * (start - overlap) };
          const b = { x: p.x + d.x * (end + overlap), y: p.y + d.y * (end + overlap) };
          strips.push([
            { x: a.x + n.x, y: a.y + n.y },
            { x: b.x + n.x, y: b.y + n.y },
            { x: b.x - n.x, y: b.y - n.y },
            { x: a.x - n.x, y: a.y - n.y },
          ]);
        }
      }
      visit(child);
    }
  };
  visit(tree);
  return { strips, islands };
}

export type CutGeometry = {
  /** Closed cut contours for the artwork, in artboard coordinates (Y down). */
  rings: Ring[];
  /** Bridge strips that were kept as metal (for previews). */
  bridges: Ring[];
  /** Islands found (enclosed metal), bridged or not. */
  islands: number;
};

/** Cut contours for the product's artwork. Requires the document's fonts to be loaded. */
export function cutGeometry(doc: StudioDocument, sign: Sign, options: DxfOptions): CutGeometry {
  let paths = openings(doc, sign, options.tolerance);
  const { strips, islands } = bridgeStrips(paths, doc.bridges);
  const bridged = doc.bridges.enabled && doc.bridges.width > 0 && strips.length > 0;
  if (bridged) paths = boolean(ClipperLib.ClipType.ctDifference, paths, strips.map(toInt));
  // Drop vertices closer than a fraction of the tolerance (keeps files lean).
  const rings = fromInt(
    ClipperLib.Clipper.CleanPolygons(paths, Math.max(1, (options.tolerance * SCALE) / 4)),
  ).filter((ring) => ring.length > 2);
  return { rings, bridges: bridged ? strips : [], islands };
}

export function artworkContours(doc: StudioDocument, sign: Sign, options: DxfOptions): Ring[] {
  return cutGeometry(doc, sign, options).rings;
}

/** Coarser tolerance for on-screen previews; DXF export uses the chosen accuracy. */
export const PREVIEW_TOLERANCE = 0.05;
const previewCache = new Map<string, CutGeometry>();

/** Cached cut geometry for previews (canvas, SVG/PNG, sheet). */
export function previewCut(doc: StudioDocument, sign: Sign): CutGeometry {
  const fonts = doc.layers
    .map((layer) => (layer.kind === "text" ? (getLoadedFont(layer.font) ? 1 : 0) : ""))
    .join("");
  const key = `${sign}|${fonts}|${JSON.stringify([doc.layers, doc.artboard, doc.bridges, Object.keys(doc.uploads)])}`;
  let result = previewCache.get(key);
  if (!result) {
    result = cutGeometry(doc, sign, { tolerance: PREVIEW_TOLERANCE });
    if (previewCache.size > 60) previewCache.clear();
    previewCache.set(key, result);
  }
  return result;
}

/** Bridges as SVG path data (artboard coordinates). */
export function bridgesPathData(rings: Ring[]) {
  return rings
    .map((ring) => `M${ring.map((p) => `${p.x.toFixed(3)} ${p.y.toFixed(3)}`).join("L")}Z`)
    .join("");
}

// ---------------------------------------------------------------------------
// DXF writing

const BULGE_QUARTER = Math.tan(Math.PI / 8); // 90° arc

function createWriter(doc: StudioDocument, reference: boolean) {
  const writer = new DxfWriter();
  writer.setUnits(doc.unit === "mm" ? Units.Millimeters : Units.Unitless);
  // Layer 0 is created by the writer itself.
  if (reference) writer.addLayer(LAYERS.sheet.name, LAYERS.sheet.color, "Continuous");
  return writer;
}

/** Writes a product outline with its top-left at (ox, oy) in a Y-down frame of height `frame`. */
function writeOutline(writer: DxfWriter, artboard: Artboard, ox: number, oy: number, frame: number, tolerance: number) {
  const { width: w, height: h } = artboard;
  const layerName = LAYERS.cut.name;
  const X = (x: number) => ox + x;
  const Y = (y: number) => frame - (oy + y);
  if (artboard.shape === "ellipse") {
    if (Math.abs(w - h) < 1e-9) {
      writer.addCircle(point3d(X(w / 2), Y(h / 2), 0), w / 2, { layerName });
      return;
    }
    const ring = flattenPath(
      `M0 ${h / 2}A${w / 2} ${h / 2} 0 1 0 ${w} ${h / 2}A${w / 2} ${h / 2} 0 1 0 0 ${h / 2}Z`,
      [1, 0, 0, 1, 0, 0],
      tolerance,
    )[0]!.points;
    writer.addLWPolyline(
      ring.map((p) => ({ point: point2d(X(p.x), Y(p.y)) })),
      { flags: LWPolylineFlags.Closed, layerName },
    );
    return;
  }
  const r = Math.min(artboard.cornerRadius, w / 2, h / 2);
  // Vertices run clockwise once Y points up, so each 90° corner arc has a negative bulge.
  const vertices = r
    ? [
        { point: point2d(X(r), Y(0)) },
        { point: point2d(X(w - r), Y(0)), bulge: -BULGE_QUARTER },
        { point: point2d(X(w), Y(r)) },
        { point: point2d(X(w), Y(h - r)), bulge: -BULGE_QUARTER },
        { point: point2d(X(w - r), Y(h)) },
        { point: point2d(X(r), Y(h)), bulge: -BULGE_QUARTER },
        { point: point2d(X(0), Y(h - r)) },
        { point: point2d(X(0), Y(r)), bulge: -BULGE_QUARTER },
      ]
    : [
        { point: point2d(X(0), Y(0)) },
        { point: point2d(X(w), Y(0)) },
        { point: point2d(X(w), Y(h)) },
        { point: point2d(X(0), Y(h)) },
      ];
  writer.addLWPolyline(vertices, { flags: LWPolylineFlags.Closed, layerName });
}

function writeContours(writer: DxfWriter, rings: Ring[], ox: number, oy: number, frame: number) {
  for (const ring of rings)
    writer.addLWPolyline(
      ring.map((p) => ({ point: point2d(ox + p.x, frame - (oy + p.y)) })),
      { flags: LWPolylineFlags.Closed, layerName: LAYERS.cut.name },
    );
}

/** A single product: outline plus artwork openings, origin at its bottom-left corner. */
export function productDxf(doc: StudioDocument, sign: Sign, options: DxfOptions) {
  const writer = createWriter(doc, false);
  writeOutline(writer, doc.artboard, 0, 0, doc.artboard.height, options.tolerance);
  writeContours(writer, artworkContours(doc, sign, options), 0, 0, doc.artboard.height);
  return writer.stringify();
}

type Segment = { a: number; b: number; at: number };

/** Merges collinear, touching or overlapping segments on the same line. */
function mergeSegments(segments: Segment[]) {
  const byLine = new Map<string, Segment[]>();
  for (const segment of segments) {
    const key = segment.at.toFixed(6);
    const list = byLine.get(key) ?? [];
    list.push({ a: Math.min(segment.a, segment.b), b: Math.max(segment.a, segment.b), at: segment.at });
    byLine.set(key, list);
  }
  const merged: Segment[] = [];
  for (const list of byLine.values()) {
    list.sort((p, q) => p.a - q.a);
    let current = { ...list[0]! };
    for (const segment of list.slice(1)) {
      if (segment.a <= current.b + 1e-6) current.b = Math.max(current.b, segment.b);
      else {
        merged.push(current);
        current = { ...segment };
      }
    }
    merged.push(current);
  }
  return merged;
}

export function canCommonLine(doc: StudioDocument) {
  return doc.sheet.spacing === 0 && doc.artboard.shape === "rect" && !doc.artboard.cornerRadius;
}

/** The whole sheet: every nested product, Y axis up with the origin at the sheet's bottom-left. */
export function sheetDxf(doc: StudioDocument, signFor: (index: number) => Sign, options: SheetDxfOptions) {
  const { sheet, artboard } = doc;
  const layout = nest(sheet, artboard);
  const writer = createWriter(doc, options.reference);
  const H = sheet.height;

  if (options.reference) {
    const rect = (x: number, y: number, w: number, h: number, layerName: string) =>
      writer.addLWPolyline(
        [
          { point: point2d(x, H - y) },
          { point: point2d(x + w, H - y) },
          { point: point2d(x + w, H - y - h) },
          { point: point2d(x, H - y - h) },
        ],
        { flags: LWPolylineFlags.Closed, layerName },
      );
    rect(0, 0, sheet.width, sheet.height, LAYERS.sheet.name);
    rect(layout.usable.x, layout.usable.y, layout.usable.width, layout.usable.height, LAYERS.sheet.name);
  }

  if (options.commonLine && canCommonLine(doc)) {
    // Shared edges are cut once: emit each grid line as a single LINE.
    const horizontal: Segment[] = [];
    const vertical: Segment[] = [];
    for (const slot of layout.slots) {
      const { x, y } = slot;
      horizontal.push({ a: x, b: x + artboard.width, at: y }, { a: x, b: x + artboard.width, at: y + artboard.height });
      vertical.push({ a: y, b: y + artboard.height, at: x }, { a: y, b: y + artboard.height, at: x + artboard.width });
    }
    const layerName = LAYERS.cut.name;
    for (const s of mergeSegments(horizontal))
      writer.addLine(point3d(s.a, H - s.at, 0), point3d(s.b, H - s.at, 0), { layerName });
    for (const s of mergeSegments(vertical))
      writer.addLine(point3d(s.at, H - s.a, 0), point3d(s.at, H - s.b, 0), { layerName });
  } else {
    for (const slot of layout.slots)
      writeOutline(writer, artboard, slot.x, slot.y, H, options.tolerance);
  }

  // Contours depend only on the sign: compute once per sign, then place.
  const cache = new Map<Sign, Ring[]>();
  for (const slot of options.artwork ? layout.slots : []) {
    const sign = signFor(slot.index);
    let rings = cache.get(sign);
    if (!rings) {
      rings = artworkContours(doc, sign, options);
      cache.set(sign, rings);
    }
    writeContours(writer, rings, slot.x, slot.y, H);
  }
  return { dxf: writer.stringify(), pieces: layout.count };
}
