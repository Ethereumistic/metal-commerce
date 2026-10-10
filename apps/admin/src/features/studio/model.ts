import type { Sign } from "./signs";

// The studio document is plain, versioned JSON so it can move from browser
// storage to a database later without a format change.

export const DOCUMENT_VERSION = 1;

export type Unit = "px" | "mm";

export type Artboard = {
  width: number;
  height: number;
  shape: "rect" | "ellipse";
  cornerRadius: number;
  background: string;
  /** Export the background fill; off = transparent background. */
  backgroundVisible: boolean;
  /** Clip artwork to the artboard shape (useful for circles). */
  clip: boolean;
  /** Safe-area inset shown as a guide and used by "fit" and edge alignment. */
  padding: number;
};

type LayerBase = {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  /** Centre of the layer's visible bounds, in artboard units. */
  x: number;
  y: number;
  rotation: number;
  opacity: number;
  color: string;
  flipX: boolean;
  flipY: boolean;
};

export type LibrarySet = "icon" | "constellation";

export type AssetSource =
  | {
      type: "library";
      set: LibrarySet;
      sign: Sign;
      /** Use the document's current sign instead of `sign` (enables batch export). */
      followDocument: boolean;
    }
  | { type: "upload"; uploadId: string };

export type AssetLayer = LayerBase & {
  kind: "asset";
  source: AssetSource;
  /** Longest side of the visible bounds, in artboard units. */
  size: number;
  /** Stroke width in source units; null keeps the source's own width. */
  strokeWidth: number | null;
};

export type FontRef = {
  /** Fontsource id, e.g. "cinzel". */
  id: string;
  family: string;
  weight: number;
  style: "normal" | "italic";
  subset: string;
};

export type TextLayer = LayerBase & {
  kind: "text";
  /** Supports `{sign}` and `{dates}` tokens. */
  text: string;
  font: FontRef;
  fontSize: number;
  /** Extra spacing between glyphs, in 1/1000 em. */
  letterSpacing: number;
  transform: "none" | "uppercase" | "lowercase";
  kerning: boolean;
  /** Bend the baseline along a circle of this radius; 0 = straight, negative = bottom arc. */
  arc: number;
};

export type ShapeLayer = LayerBase & {
  kind: "shape";
  shape: "rect" | "ellipse";
  /** Outer visible size, including any outline. */
  width: number;
  height: number;
  cornerRadius: number;
  fill: boolean;
  strokeWidth: number;
};

export type Layer = AssetLayer | TextLayer | ShapeLayer;
export type LayerKind = Layer["kind"];

export type Upload = { id: string; name: string; svg: string };

export type StudioDocument = {
  version: typeof DOCUMENT_VERSION;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  unit: Unit;
  /** The sign used by layers that follow the document (and by `{sign}` tokens). */
  sign: Sign;
  artboard: Artboard;
  /** Bottom to top. */
  layers: Layer[];
  uploads: Record<string, Upload>;
};

export const DEFAULT_FONT: FontRef = {
  id: "cinzel",
  family: "Cinzel",
  weight: 400,
  style: "normal",
  subset: "latin",
};

export const uid = () => crypto.randomUUID();

function base(name: string, artboard: Artboard): LayerBase {
  return {
    id: uid(),
    name,
    visible: true,
    locked: false,
    x: artboard.width / 2,
    y: artboard.height / 2,
    rotation: 0,
    opacity: 1,
    color: "#ffffff",
    flipX: false,
    flipY: false,
  };
}

export function createAssetLayer(
  artboard: Artboard,
  source: AssetSource,
  name: string,
): AssetLayer {
  return {
    ...base(name, artboard),
    kind: "asset",
    source,
    // 390 / 704 matches the accepted zodiac icon scale from the vector sets.
    size: Math.round(Math.min(artboard.width, artboard.height) * (390 / 704)),
    strokeWidth: null,
  };
}

export function createTextLayer(artboard: Artboard, text = "{sign}"): TextLayer {
  const layer = base("Text", artboard);
  return {
    ...layer,
    kind: "text",
    y: artboard.height * 0.85,
    text,
    font: DEFAULT_FONT,
    fontSize: Math.round(Math.min(artboard.width, artboard.height) * 0.07),
    letterSpacing: 150,
    transform: "uppercase",
    kerning: true,
    arc: 0,
  };
}

export function createShapeLayer(
  artboard: Artboard,
  shape: ShapeLayer["shape"],
  fill: boolean,
): ShapeLayer {
  const side = Math.round(Math.min(artboard.width, artboard.height) * 0.9);
  return {
    ...base(fill ? (shape === "ellipse" ? "Circle" : "Rectangle") : shape === "ellipse" ? "Ring" : "Frame", artboard),
    kind: "shape",
    shape,
    width: side,
    height: side,
    cornerRadius: 0,
    fill,
    strokeWidth: fill ? 0 : Math.max(1, Math.round(side * 0.012)),
  };
}

export function createDocument(
  name = "Untitled design",
  sign: Sign = "aries",
): StudioDocument {
  const now = Date.now();
  return {
    version: DOCUMENT_VERSION,
    id: uid(),
    name,
    createdAt: now,
    updatedAt: now,
    unit: "px",
    sign,
    artboard: {
      width: 704,
      height: 704,
      shape: "rect",
      cornerRadius: 0,
      background: "#151515",
      backgroundVisible: true,
      clip: false,
      padding: 48,
    },
    layers: [],
    uploads: {},
  };
}

export type Template = "blank" | "icon" | "icon-constellation" | "icon-name";

export function createFromTemplate(template: Template, sign: Sign = "aries") {
  const doc = createDocument(
    {
      blank: "Untitled design",
      icon: "Zodiac icon",
      "icon-constellation": "Icon + constellation",
      "icon-name": "Icon + name",
    }[template],
    sign,
  );
  const follow = (set: "icon" | "constellation", name: string) =>
    createAssetLayer(
      doc.artboard,
      { type: "library", set, sign, followDocument: true },
      name,
    );
  if (template === "icon") doc.layers.push(follow("icon", "Zodiac icon"));
  if (template === "icon-constellation")
    doc.layers.push(
      follow("constellation", "Constellation"),
      follow("icon", "Zodiac icon"),
    );
  if (template === "icon-name") {
    const icon = follow("icon", "Zodiac icon");
    icon.size = Math.round(doc.artboard.width * 0.45);
    icon.y = doc.artboard.height * 0.44;
    doc.layers.push(icon, createTextLayer(doc.artboard));
  }
  return doc;
}

/** Validates and upgrades an unknown value (storage, file import) to a document. */
export function parseDocument(value: unknown): StudioDocument {
  if (!value || typeof value !== "object") throw new Error("Not a design file");
  const doc = value as Partial<StudioDocument>;
  if (doc.version !== DOCUMENT_VERSION)
    throw new Error(`Unsupported design version: ${String(doc.version)}`);
  if (
    typeof doc.id !== "string" ||
    !doc.artboard ||
    !Array.isArray(doc.layers) ||
    typeof doc.name !== "string"
  )
    throw new Error("Design file is incomplete");
  return { ...doc, uploads: doc.uploads ?? {} } as StudioDocument;
}
