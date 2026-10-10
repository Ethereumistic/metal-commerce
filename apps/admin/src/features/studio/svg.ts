// Parses SVG sources into reusable, monochrome fragments.
// Library sources are trusted repository files; uploads go through the same
// allowlist so no scripts, external references or foreign content survive.

export type ParsedSvg = {
  /** Source viewBox [x, y, width, height]. */
  viewBox: [number, number, number, number];
  /** Presentation attributes from the root <svg>, applied to a wrapper <g>. */
  attributes: Record<string, string>;
  /** Inner markup, recoloured to currentColor. */
  markup: string;
  /** Whether any geometry is painted with a stroke (affects visible bounds). */
  stroked: boolean;
  /** Stroke width declared on the root, if any. */
  strokeWidth: number | null;
};

const SVG_NS = "http://www.w3.org/2000/svg";

const ALLOWED_ELEMENTS = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline",
  "polygon", "defs", "clippath", "mask", "lineargradient", "radialgradient",
  "stop", "use", "symbol",
]);

const ROOT_PRESENTATION = [
  "fill", "fill-rule", "fill-opacity", "stroke", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-opacity",
  "clip-rule",
];

const PAINT = /^(fill|stroke)$/;

function isColour(value: string) {
  const v = value.trim().toLowerCase();
  return v !== "none" && v !== "transparent" && !v.startsWith("url(");
}

function sanitizeAttributes(element: Element, idPrefix: string) {
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value;
    if (name.startsWith("on") || name === "class") {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (name === "href" || name === "xlink:href") {
      if (!value.startsWith("#")) element.removeAttribute(attribute.name);
      else element.setAttribute(attribute.name, `#${idPrefix}${value.slice(1)}`);
      continue;
    }
    if (name === "id") {
      element.setAttribute("id", `${idPrefix}${value}`);
      continue;
    }
    if (name === "style") {
      // Keep plain declarations; drop anything that can reference external content.
      const kept = value
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part && !/url\(\s*['"]?(?!#)|expression|@import/i.test(part));
      if (kept.length) element.setAttribute("style", kept.join(";"));
      else element.removeAttribute("style");
    }
    if (/url\(\s*['"]?#/.test(value))
      element.setAttribute(
        attribute.name,
        value.replace(/url\(\s*(['"]?)#/g, `url($1#${idPrefix}`),
      );
  }
}

function recolor(element: Element) {
  for (const attribute of Array.from(element.attributes)) {
    if (PAINT.test(attribute.name) && isColour(attribute.value))
      element.setAttribute(attribute.name, "currentColor");
  }
  const style = element.getAttribute("style");
  if (style)
    element.setAttribute(
      "style",
      style.replace(/(^|;)\s*(fill|stroke)\s*:\s*([^;]+)/g, (match, lead, prop, value) =>
        isColour(value) ? `${lead}${prop}:currentColor` : match,
      ),
    );
}

function paints(element: Element, property: "fill" | "stroke") {
  const attribute = element.getAttribute(property);
  if (attribute) return isColour(attribute);
  const style = element.getAttribute("style") ?? "";
  const match = style.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
  return match ? isColour(match[1]!) : undefined;
}

function number(value: string | null) {
  if (value == null) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseSvg(source: string, idPrefix: string): ParsedSvg {
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = document.documentElement;
  if (root.nodeName.toLowerCase() !== "svg" || document.querySelector("parsererror"))
    throw new Error("The file is not a valid SVG.");

  // Remove disallowed elements (scripts, images, foreignObject, style, text…).
  for (const element of Array.from(root.querySelectorAll("*")))
    if (!ALLOWED_ELEMENTS.has(element.localName.toLowerCase())) element.remove();

  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    sanitizeAttributes(element, idPrefix);
    recolor(element);
  }

  const box = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const viewBox: ParsedSvg["viewBox"] =
    box.length === 4 && box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0
      ? [box[0]!, box[1]!, box[2]!, box[3]!]
      : [0, 0, number(root.getAttribute("width")) ?? 100, number(root.getAttribute("height")) ?? 100];

  const attributes: Record<string, string> = {};
  for (const name of ROOT_PRESENTATION) {
    const value = root.getAttribute(name);
    if (value != null) attributes[name] = value;
  }
  // SVG paints black by default; make it follow the layer colour instead.
  if (!("fill" in attributes)) attributes.fill = "currentColor";

  const elements = Array.from(root.querySelectorAll("*"));
  const rootStroke = paints(root, "stroke") ?? false;
  const stroked =
    rootStroke ||
    elements.some((element) => paints(element, "stroke") === true);

  const serializer = new XMLSerializer();
  const markup = Array.from(root.childNodes)
    .filter((node) => node.nodeType === Node.ELEMENT_NODE)
    .map((node) => serializer.serializeToString(node))
    .join("")
    // XMLSerializer repeats the namespace on each top-level child; the host <svg> already declares it.
    .replaceAll(` xmlns="${SVG_NS}"`, "");

  return {
    viewBox,
    attributes,
    markup,
    stroked,
    strokeWidth: number(root.getAttribute("stroke-width")),
  };
}

export function escapeAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function attributesToString(attributes: Record<string, string | number>) {
  return Object.entries(attributes)
    .map(([key, value]) => ` ${key}="${escapeAttribute(String(value))}"`)
    .join("");
}
