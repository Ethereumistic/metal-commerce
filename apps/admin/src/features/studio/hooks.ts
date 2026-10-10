import { useEffect, useMemo, useState } from "react";
import { bridgesPathData, previewCut } from "./dxf";
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

export type CutPreview = { bridges: string; islands: number };

/** Islands and bridges for the canvas, recomputed shortly after edits settle. */
export function useCutPreview(doc: StudioDocument, delay = 150) {
  const fontStatus = useFontStatus((state) => state.status);
  const [preview, setPreview] = useState<CutPreview>({ bridges: "", islands: 0 });
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const cut = previewCut(doc, doc.sign);
        setPreview({ bridges: bridgesPathData(cut.bridges), islands: cut.islands });
      } catch {
        setPreview({ bridges: "", islands: 0 });
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [doc, fontStatus, delay]);
  return preview;
}
