import { parseSvg, type ParsedSvg } from "./svg";
import { SIGNS, SIGN_LABELS, type Sign } from "./signs";
import type { LibrarySet } from "./model";

// Source artwork lives in the repository's design artifacts:
// Tabler zodiac icons (MIT) and the owner's constellation drawings.
const iconSources = import.meta.glob<string>(
  "../../../../../artifacts/zodiac-products/icons/zodiac-*.svg",
  { query: "?raw", import: "default", eager: true },
);
const constellationSources = import.meta.glob<string>(
  "../../../../../artifacts/zodiac-products/constellations/*.svg",
  { query: "?raw", import: "default", eager: true },
);

function bySign(sources: Record<string, string>, pattern: RegExp) {
  const result = {} as Record<Sign, string>;
  for (const [path, svg] of Object.entries(sources)) {
    const sign = path.match(pattern)?.[1] as Sign | undefined;
    if (sign && (SIGNS as readonly string[]).includes(sign)) result[sign] = svg;
  }
  return result;
}

export const LIBRARY_SOURCES: Record<LibrarySet, Record<Sign, string>> = {
  icon: bySign(iconSources, /zodiac-([a-z]+)\.svg$/),
  constellation: bySign(constellationSources, /\/([a-z]+)\.svg$/),
};

export const LIBRARY_SET_LABELS: Record<LibrarySet, string> = {
  icon: "Zodiac icon",
  constellation: "Constellation",
};

export function libraryName(set: LibrarySet, sign: Sign) {
  return `${SIGN_LABELS[sign]} ${set === "icon" ? "icon" : "constellation"}`;
}

const parsed = new Map<string, ParsedSvg>();

/** Parsed library artwork; parsing is cached and only runs in the browser. */
export function libraryAsset(set: LibrarySet, sign: Sign): ParsedSvg {
  const key = `${set}:${sign}`;
  let asset = parsed.get(key);
  if (!asset) {
    asset = parseSvg(LIBRARY_SOURCES[set][sign], `lib-${set}-${sign}-`);
    parsed.set(key, asset);
  }
  return asset;
}

const uploads = new Map<string, ParsedSvg>();

export function uploadAsset(id: string, svg: string): ParsedSvg {
  const key = `${id}:${svg.length}`;
  let asset = uploads.get(key);
  if (!asset) {
    asset = parseSvg(svg, `up-${id.slice(0, 8)}-`);
    uploads.set(key, asset);
  }
  return asset;
}
