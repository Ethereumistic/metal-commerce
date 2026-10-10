import { useEffect, useMemo } from "react";
import { ensureFont, fontKey, useFontStatus } from "./fonts";
import { resolveLayer, type Resolved } from "./geometry";
import type { Layer, StudioDocument } from "./model";

/** Starts loading every font the document uses. */
export function useDocumentFonts(doc: StudioDocument) {
  const keys = doc.layers
    .filter((layer) => layer.kind === "text")
    .map((layer) => (layer.kind === "text" ? fontKey(layer.font) : ""))
    .join("|");
  useEffect(() => {
    for (const layer of doc.layers)
      if (layer.kind === "text") ensureFont(layer.font).catch(() => undefined);
    // `keys` captures every font reference; the layers array itself changes on any edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);
}

/** Resolved geometry for each layer; recomputes when fonts finish loading. */
export function useResolvedLayers(doc: StudioDocument) {
  useDocumentFonts(doc);
  const fontStatus = useFontStatus((state) => state.status);
  return useMemo(() => {
    const map = new Map<string, Resolved | null>();
    for (const layer of doc.layers) map.set(layer.id, resolveLayer(layer, doc));
    return map;
    // fontStatus forces re-resolution once a font is ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, fontStatus]);
}

export function useFontState(layer: Layer | null) {
  return useFontStatus((state) =>
    layer?.kind === "text" ? state.status[fontKey(layer.font)] : undefined,
  );
}
