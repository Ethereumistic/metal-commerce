import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFontStatus } from "../fonts";
import { useDocumentFonts } from "../hooks";
import { renderSheetSvg } from "../render";
import { nest } from "../sheet";
import { useActiveDocument } from "../store";

const MARGIN = 64;

/** Read-only preview of the product nested on the machine sheet. */
export function SheetView() {
  const doc = useActiveDocument();
  useDocumentFonts(doc);
  const fontStatus = useFontStatus((state) => state.status);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const { sheet } = doc;
  const layout = nest(sheet, doc.artboard);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale = Math.max(
    0.01,
    Math.min((viewport.width - MARGIN * 2) / sheet.width, (viewport.height - MARGIN * 2) / sheet.height),
  );
  const width = Math.round(sheet.width * scale);
  const height = Math.round(sheet.height * scale);

  const markup = useMemo(
    () => (viewport.width ? renderSheetSvg(doc, { guides: true, pixelWidth: width }) : ""),
    // fontStatus re-renders once outlined text fonts arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, width, fontStatus, viewport.width],
  );

  return (
    <div ref={viewportRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-neutral-100 [color-scheme:light]">
      {markup && (
        <div
          className="absolute"
          style={{
            left: (viewport.width - width) / 2,
            top: (viewport.height - height) / 2,
            width,
            height,
          }}
        >
          <div
            className="size-full shadow-md [&>svg]:block"
            dangerouslySetInnerHTML={{ __html: markup }}
            role="img"
            aria-label={`Sheet ${sheet.width} by ${sheet.height} millimetres with ${layout.count} pieces`}
          />
          <span className="absolute -top-6 left-0 w-full text-center text-xs text-neutral-500 tabular-nums">
            {sheet.width} mm
          </span>
          <span className="absolute top-0 -left-6 flex h-full items-center text-xs text-neutral-500 tabular-nums [writing-mode:vertical-rl] rotate-180">
            {sheet.height} mm
          </span>
          <span className="absolute -bottom-6 left-0 w-full text-center text-xs text-neutral-500">
            {layout.cols} × {layout.rows} = {layout.count} pieces · dashed line = {sheet.margin} mm safety margin
          </span>
        </div>
      )}
    </div>
  );
}
