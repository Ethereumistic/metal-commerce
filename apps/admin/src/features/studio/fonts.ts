import { parse, Path, type Font, type PathCommand } from "opentype.js";
import { create } from "zustand";
import type { FontRef, TextLayer } from "./model";

// Google Fonts via Fontsource: a CORS-enabled catalogue and static TTF files
// that opentype.js can parse. Text is converted to vector outlines, so exported
// SVG/PNG files render identically without the font installed.

const CATALOG_URL = "https://api.fontsource.org/v1/fonts?type=google";
const fontFileUrl = (font: FontRef) =>
  `https://cdn.jsdelivr.net/fontsource/fonts/${font.id}@latest/${font.subset}-${font.weight}-${font.style}.ttf`;

export type CatalogFont = {
  id: string;
  family: string;
  subsets: string[];
  weights: number[];
  styles: ("normal" | "italic")[];
  defSubset: string;
  category: string;
};

let catalogRequest: Promise<CatalogFont[]> | null = null;

export function loadCatalog() {
  catalogRequest ??= fetch(CATALOG_URL)
    .then((response) => {
      if (!response.ok) throw new Error(`Font catalogue HTTP ${response.status}`);
      return response.json() as Promise<CatalogFont[]>;
    })
    .then((fonts) => fonts.sort((a, b) => a.family.localeCompare(b.family)))
    .catch((error) => {
      catalogRequest = null;
      throw error;
    });
  return catalogRequest;
}

export const fontKey = (font: FontRef) =>
  `${font.id}/${font.subset}/${font.weight}/${font.style}`;

type FontStatus = "loading" | "ready" | "error";

/** Reactive load status, so components re-render when a font arrives. */
export const useFontStatus = create<{ status: Record<string, FontStatus> }>(() => ({
  status: {},
}));

const loaded = new Map<string, Font>();
const pending = new Map<string, Promise<Font>>();

export function getLoadedFont(font: FontRef) {
  return loaded.get(fontKey(font));
}

export function ensureFont(font: FontRef): Promise<Font> {
  const key = fontKey(font);
  const ready = loaded.get(key);
  if (ready) return Promise.resolve(ready);
  let request = pending.get(key);
  if (!request) {
    useFontStatus.setState((s) => ({ status: { ...s.status, [key]: "loading" } }));
    request = fetch(fontFileUrl(font))
      .then((response) => {
        if (!response.ok) throw new Error(`Font HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((buffer) => {
        const parsed = parse(buffer);
        loaded.set(key, parsed);
        useFontStatus.setState((s) => ({ status: { ...s.status, [key]: "ready" } }));
        return parsed;
      })
      .catch((error) => {
        pending.delete(key);
        useFontStatus.setState((s) => ({ status: { ...s.status, [key]: "error" } }));
        throw error;
      });
    pending.set(key, request);
  }
  return request;
}

export type TextOutline = {
  /** SVG path data, baseline at y = 0, centred horizontally for arcs. */
  d: string;
  bounds: { x: number; y: number; width: number; height: number };
  /** Characters the font has no glyph for. */
  missing: string[];
};

function transformCommands(
  commands: PathCommand[],
  map: (x: number, y: number) => [number, number],
) {
  return commands.map((command) => {
    const next = { ...command } as PathCommand & Record<string, number>;
    const c = command as PathCommand & Record<string, number>;
    if ("x" in c && "y" in c) [next.x, next.y] = map(c.x, c.y);
    if ("x1" in c && "y1" in c) [next.x1, next.y1] = map(c.x1, c.y1);
    if ("x2" in c && "y2" in c) [next.x2, next.y2] = map(c.x2, c.y2);
    return next as PathCommand;
  });
}

export function layoutText(
  font: Font,
  text: string,
  layer: Pick<TextLayer, "fontSize" | "letterSpacing" | "kerning" | "arc">,
): TextOutline | null {
  if (!text.trim()) return null;
  const scale = layer.fontSize / font.unitsPerEm;
  const tracking = (layer.letterSpacing / 1000) * layer.fontSize;
  const glyphs = font.stringToGlyphs(text);
  const chars = Array.from(text);
  const missing = [
    ...new Set(chars.filter((_, index) => glyphs[index]?.index === 0)),
  ].filter((char) => char.trim());

  // Advance positions along the baseline.
  const placements: { glyph: (typeof glyphs)[number]; x: number; advance: number }[] = [];
  let x = 0;
  glyphs.forEach((glyph, index) => {
    const advance = (glyph.advanceWidth ?? 0) * scale;
    placements.push({ glyph, x, advance });
    x += advance;
    const next = glyphs[index + 1];
    if (next) {
      if (layer.kerning) x += font.getKerningValue(glyph, next) * scale;
      x += tracking;
    }
  });
  const width = x;

  const path = new Path();
  for (const { glyph, x: gx, advance } of placements) {
    if (!layer.arc) {
      path.extend(glyph.getPath(gx, 0, layer.fontSize));
      continue;
    }
    // Place each glyph upright on a circle: centre of the circle at (0, arc),
    // the glyph's horizontal midpoint maps to an angle along the arc.
    const mid = gx + advance / 2 - width / 2;
    const angle = mid / layer.arc;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const local = glyph.getPath(-advance / 2, 0, layer.fontSize);
    // Rotate around the circle centre (0, arc), after moving the glyph's
    // midpoint to x = 0 on the baseline.
    path.extend(
      transformCommands(local.commands, (px, py) => {
        const dy = py - layer.arc;
        return [px * cos - dy * sin, px * sin + dy * cos + layer.arc];
      }),
    );
  }
  if (!path.commands.length) return null;
  const box = path.getBoundingBox();
  if (!Number.isFinite(box.x1) || box.x2 - box.x1 <= 0) return null;
  return {
    d: path.toPathData(3),
    bounds: { x: box.x1, y: box.y1, width: box.x2 - box.x1, height: box.y2 - box.y1 },
    missing,
  };
}
