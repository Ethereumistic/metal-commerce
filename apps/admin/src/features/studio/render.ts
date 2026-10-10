import { strToU8, zipSync } from "fflate";
import { ensureFont } from "./fonts";
import { artboardShapeMarkup, layerTransform, resolveLayer } from "./geometry";
import type { StudioDocument } from "./model";
import { SIGNS, type Sign } from "./signs";
import { attributesToString, escapeAttribute } from "./svg";

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

/** Self-contained SVG: vector-only, no fonts, scripts or external references. */
export function renderSvg(doc: StudioDocument, options: RenderOptions = {}) {
  const sign = options.sign ?? doc.sign;
  const { artboard } = doc;
  const background = options.background ?? artboard.backgroundVisible;
  const size = options.pixelWidth
    ? {
        width: options.pixelWidth,
        height: Math.round((options.pixelWidth * artboard.height) / artboard.width),
      }
    : {
        width: `${artboard.width}${doc.unit === "mm" ? "mm" : ""}`,
        height: `${artboard.height}${doc.unit === "mm" ? "mm" : ""}`,
      };

  const layers = doc.layers
    .filter((layer) => layer.visible)
    .map((layer) => {
      const resolved = resolveLayer(layer, doc, sign);
      if (!resolved) return "";
      const attributes: Record<string, string | number> = {
        transform: layerTransform(layer, resolved),
        color: layer.color,
      };
      if (layer.opacity < 1) attributes.opacity = layer.opacity;
      return `<g${attributesToString(attributes)}>${resolved.markup}</g>`;
    })
    .join("");

  const clip = artboard.clip
    ? `<defs><clipPath id="artboard-clip">${artboardShapeMarkup(artboard, "")}</clipPath></defs>`
    : "";
  const body = artboard.clip ? `<g clip-path="url(#artboard-clip)">${layers}</g>` : layers;
  const fill = background
    ? artboardShapeMarkup(artboard, ` fill="${escapeAttribute(artboard.background)}"`)
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${artboard.width} ${artboard.height}">${clip}${fill}${body}</svg>`;
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

export type ExportFormat = "svg" | "png";

export type ExportRequest = {
  formats: ExportFormat[];
  /** Pixel width of PNG exports. */
  pngWidth: number;
  background: boolean;
  signs: "current" | "all";
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
