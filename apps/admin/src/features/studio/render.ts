import { strToU8, zipSync } from "fflate";
import { ensureFont } from "./fonts";
import { productDxf, sheetDxf } from "./dxf";
import { artboardShapeMarkup, layerMarkup } from "./geometry";
import type { StudioDocument } from "./model";
import { nest } from "./sheet";
import { SIGNS, type Sign } from "./signs";
import { escapeAttribute } from "./svg";

export type RenderOptions = {
  sign?: Sign;
  background?: boolean;
  /** Override the root width/height attributes (PNG rasterisation). */
  pixelWidth?: number;
};

/** Loads every font the document needs so rendering is complete. */
export async function prepareFonts(doc: StudioDocument) {
  await Promise.all(
    doc.layers
      .filter((layer) => layer.kind === "text" && layer.visible)
      .map((layer) => (layer.kind === "text" ? ensureFont(layer.font) : null)),
  );
}

/** Artwork markup in artboard coordinates (no root <svg>). */
export function renderArtwork(
  doc: StudioDocument,
  options: { sign?: Sign; background?: boolean; idPrefix?: string } = {},
) {
  const sign = options.sign ?? doc.sign;
  const { artboard } = doc;
  const background = options.background ?? artboard.backgroundVisible;
  const clipId = `${options.idPrefix ?? ""}artboard-clip`;

  const layers = doc.layers
    .filter((layer) => layer.visible)
    .map((layer) => layerMarkup(doc, layer, sign))
    .join("");

  const clip = artboard.clip
    ? `<defs><clipPath id="${clipId}">${artboardShapeMarkup(artboard, "")}</clipPath></defs>`
    : "";
  const body = artboard.clip ? `<g clip-path="url(#${clipId})">${layers}</g>` : layers;
  const fill = background
    ? artboardShapeMarkup(artboard, ` fill="${escapeAttribute(artboard.background)}"`)
    : "";
  return `${clip}${fill}${body}`;
}

/** Self-contained SVG: vector-only, no fonts, scripts or external references. */
export function renderSvg(doc: StudioDocument, options: RenderOptions = {}) {
  const { artboard } = doc;
  const size = options.pixelWidth
    ? {
        width: options.pixelWidth,
        height: Math.round((options.pixelWidth * artboard.height) / artboard.width),
      }
    : {
        width: `${artboard.width}${doc.unit === "mm" ? "mm" : ""}`,
        height: `${artboard.height}${doc.unit === "mm" ? "mm" : ""}`,
      };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${artboard.width} ${artboard.height}">${renderArtwork(doc, options)}</svg>`;
}

export type SheetRenderOptions = {
  /** Draw the safety margin and leftover area (preview aid; off for production files). */
  guides?: boolean;
  /** Draw the artwork inside each piece; off shows outlines only. */
  artwork?: boolean;
  /** Draw each piece's cut outline. */
  outlines?: boolean;
  pixelWidth?: number;
};

export function signForSlot(doc: StudioDocument, index: number): Sign {
  if (doc.sheet.fill === "same") return doc.sign;
  return SIGNS[(SIGNS.indexOf(doc.sign) + index) % SIGNS.length]!;
}

/** The machine sheet with every nested piece, in millimetre user units. */
export function renderSheetSvg(doc: StudioDocument, options: SheetRenderOptions = {}) {
  const { sheet, artboard } = doc;
  const layout = nest(sheet, artboard);
  const guides = options.guides ?? false;
  const artwork = options.artwork ?? true;
  const outlines = options.outlines ?? true;
  const stroke = Math.max(sheet.width, sheet.height) / 1500; // ≈ 2 mm on the current machine

  const pieces = layout.slots
    .map((slot) => {
      const inner = artwork
        ? renderArtwork(doc, { sign: signForSlot(doc, slot.index), idPrefix: `p${slot.index}-` })
        : "";
      const outline = outlines
        ? artboardShapeMarkup(artboard, ` fill="none" stroke="#38bdf8" stroke-width="${stroke}"`)
        : "";
      return `<g transform="translate(${slot.x} ${slot.y})">${inner}${outline}</g>`;
    })
    .join("");

  const margin = guides
    ? `<rect x="${layout.usable.x}" y="${layout.usable.y}" width="${layout.usable.width}" height="${layout.usable.height}" fill="none" stroke="#f59e0b" stroke-width="${stroke}" stroke-dasharray="${stroke * 8} ${stroke * 5}"/>`
    : "";
  const size = options.pixelWidth
    ? { width: options.pixelWidth, height: Math.round((options.pixelWidth * sheet.height) / sheet.width) }
    : { width: `${sheet.width}mm`, height: `${sheet.height}mm` };

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${sheet.width} ${sheet.height}"><rect width="${sheet.width}" height="${sheet.height}" fill="#c9cdd2"/>${margin}${pieces}</svg>`;
}

export async function rasterize(svg: string, width: number, height: number) {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    context.drawImage(image, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))),
        "image/png",
      ),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function slug(value: string) {
  return (
    value
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "design"
  );
}

export type ExportFormat = "svg" | "png" | "dxf";

/** Default DXF curve tolerance in design units (mm): far below laser kerf. */
export const DXF_TOLERANCE = 0.02;

export type ExportRequest = {
  formats: ExportFormat[];
  /** Pixel width of PNG exports. */
  pngWidth: number;
  background: boolean;
  signs: "current" | "all";
  /** DXF curve tolerance in design units. */
  tolerance?: number;
};

/** Whether any layer changes with the document sign (makes "all signs" meaningful). */
export function usesSign(doc: StudioDocument) {
  return doc.layers.some(
    (layer) =>
      (layer.kind === "asset" &&
        layer.source.type === "library" &&
        layer.source.followDocument) ||
      (layer.kind === "text" && /\{(sign|dates)\}/.test(layer.text)),
  );
}

async function renderFiles(doc: StudioDocument, request: ExportRequest, sign: Sign) {
  const name = `${slug(doc.name)}${request.signs === "all" || usesSign(doc) ? `-${sign}` : ""}`;
  const files: { name: string; data: Blob }[] = [];
  if (request.formats.includes("svg"))
    files.push({
      name: `${name}.svg`,
      data: new Blob([renderSvg(doc, { sign, background: request.background })], {
        type: "image/svg+xml",
      }),
    });
  if (request.formats.includes("png")) {
    const width = request.pngWidth;
    const height = Math.round((width * doc.artboard.height) / doc.artboard.width);
    const svg = renderSvg(doc, { sign, background: request.background, pixelWidth: width });
    files.push({ name: `${name}.png`, data: await rasterize(svg, width, height) });
  }
  if (request.formats.includes("dxf"))
    files.push({
      name: `${name}.dxf`,
      data: new Blob([productDxf(doc, sign, { tolerance: request.tolerance ?? DXF_TOLERANCE })], {
        type: "application/dxf",
      }),
    });
  return files;
}

export async function exportDocument(doc: StudioDocument, request: ExportRequest) {
  await prepareFonts(doc);
  const signs = request.signs === "all" ? [...SIGNS] : [doc.sign];
  const files = (
    await Promise.all(signs.map((sign) => renderFiles(doc, request, sign)))
  ).flat();
  if (files.length === 1) return download(files[0]!.data, files[0]!.name);
  const entries: Record<string, Uint8Array> = {};
  for (const file of files)
    entries[file.name] = new Uint8Array(await file.data.arrayBuffer());
  entries["design.json"] = strToU8(JSON.stringify(doc, null, 2));
  const zip = zipSync(entries, { level: 6 });
  download(
    new Blob([zip as Uint8Array<ArrayBuffer>], { type: "application/zip" }),
    `${slug(doc.name)}${request.signs === "all" ? "-all-signs" : ""}.zip`,
  );
}

export function exportProject(doc: StudioDocument) {
  download(
    new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }),
    `${slug(doc.name)}.design.json`,
  );
}

export async function exportSheet(
  doc: StudioDocument,
  format: ExportFormat,
  options: {
    artwork: boolean;
    pngWidth: number;
    tolerance?: number;
    commonLine?: boolean;
    reference?: boolean;
  },
) {
  await prepareFonts(doc);
  const name = `${slug(doc.name)}-sheet-${doc.sheet.width}x${doc.sheet.height}`;
  if (format === "dxf") {
    const { dxf } = sheetDxf(doc, (index) => signForSlot(doc, index), {
      tolerance: options.tolerance ?? DXF_TOLERANCE,
      commonLine: options.commonLine ?? true,
      reference: options.reference ?? true,
      artwork: options.artwork,
    });
    return download(new Blob([dxf], { type: "application/dxf" }), `${name}.dxf`);
  }
  if (format === "svg")
    return download(
      new Blob([renderSheetSvg(doc, { artwork: options.artwork })], { type: "image/svg+xml" }),
      `${name}.svg`,
    );
  const width = options.pngWidth;
  const height = Math.round((width * doc.sheet.height) / doc.sheet.width);
  const svg = renderSheetSvg(doc, { artwork: options.artwork, pixelWidth: width });
  download(await rasterize(svg, width, height), `${name}.png`);
}
