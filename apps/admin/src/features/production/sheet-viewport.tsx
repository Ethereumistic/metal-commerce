import { memo, useCallback, useEffect, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import type { Sheet } from "./contracts";

// The interactive sheet: real cut contours, zoom and pan. Each part is a div
// masked by its master's SVG (exact outline, holes included) and filled with
// its line colour, so the browser rasterises each master once and reuses it.
// Zoom and pan only change one wrapper's CSS transform, applied directly to
// the element, so moving around never re-renders React.

export type PartLook = {
  name: string;
  colour: string;
  width: number;
  height: number;
  /** Same-origin URL of the master's SVG, or null to draw the bounding box. */
  mask: string | null;
};

type View = { x: number; y: number; scale: number };

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 60;

const Parts = memo(function Parts({
  sheet,
  looks,
}: {
  sheet: Sheet;
  looks: ReadonlyMap<string, PartLook>;
}) {
  return (
    <>
      {sheet.placements.map((placement) => {
        const look = looks.get(placement.line_id);
        if (!look) return null;
        // Service frame: Y up, part rotated about its lower-left corner, then
        // moved to (tx, ty). The div is laid out Y down from the sheet's top.
        const style: CSSProperties = {
          width: look.width,
          height: look.height,
          transform: `translate(${placement.tx_mm}px, ${sheet.height_mm - placement.ty_mm}px) rotate(${-placement.rotation_deg}deg) translate(0, ${-look.height}px)`,
          ...(look.mask
            ? {
                backgroundColor: look.colour,
                maskImage: `url("${look.mask}")`,
                maskSize: "100% 100%",
                maskRepeat: "no-repeat",
                WebkitMaskImage: `url("${look.mask}")`,
                WebkitMaskSize: "100% 100%",
                WebkitMaskRepeat: "no-repeat",
              }
            : { backgroundColor: `${look.colour}33`, outline: `1px solid ${look.colour}` }),
        };
        return (
          <div
            key={placement.instance_id}
            className="absolute top-0 left-0 origin-top-left"
            style={style}
            title={`${look.name}, ${placement.rotation_deg}°`}
          />
        );
      })}
    </>
  );
});

const Guides = memo(function Guides({
  sheet,
  looks,
  margins,
  boxes,
}: {
  sheet: Sheet;
  looks: ReadonlyMap<string, PartLook>;
  margins: { left: number; right: number; bottom: number; top: number } | null;
  boxes: boolean;
}) {
  const stroke = Math.max(sheet.width_mm, sheet.height_mm) / 900;
  return (
    <svg
      className="pointer-events-none absolute top-0 left-0 overflow-visible"
      width={sheet.width_mm}
      height={sheet.height_mm}
      viewBox={`0 0 ${sheet.width_mm} ${sheet.height_mm}`}
      aria-hidden
    >
      {margins && (
        <rect
          x={margins.left}
          y={margins.top}
          width={Math.max(0, sheet.width_mm - margins.left - margins.right)}
          height={Math.max(0, sheet.height_mm - margins.bottom - margins.top)}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.45}
          strokeDasharray={`${stroke * 8} ${stroke * 6}`}
          strokeWidth={stroke * 1.5}
        />
      )}
      {boxes && (
        <g transform={`translate(0 ${sheet.height_mm}) scale(1 -1)`}>
          {sheet.placements.map((placement) => {
            const look = looks.get(placement.line_id);
            if (!look) return null;
            return (
              <rect
                key={placement.instance_id}
                width={look.width}
                height={look.height}
                transform={`translate(${placement.tx_mm} ${placement.ty_mm}) rotate(${placement.rotation_deg})`}
                fill="none"
                stroke={look.colour}
                strokeWidth={stroke}
                strokeDasharray={`${stroke * 5} ${stroke * 3}`}
              />
            );
          })}
        </g>
      )}
    </svg>
  );
});

export function SheetViewport({
  sheet,
  label,
  looks,
  margins,
  boxes,
}: {
  sheet: Sheet;
  label: string;
  looks: ReadonlyMap<string, PartLook>;
  margins: { left: number; right: number; bottom: number; top: number } | null;
  boxes: boolean;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const view = useRef<View>({ x: 0, y: 0, scale: 1 });
  const fitScale = useRef(1);
  const frameRequest = useRef(0);
  const drag = useRef<{ x: number; y: number; view: View } | null>(null);

  const paint = useCallback(() => {
    cancelAnimationFrame(frameRequest.current);
    frameRequest.current = requestAnimationFrame(() => {
      const { x, y, scale } = view.current;
      if (stage.current) stage.current.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    });
  }, []);

  const fit = useCallback(() => {
    const box = frame.current?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return;
    const pad = 24;
    const scale = Math.min((box.width - pad * 2) / sheet.width_mm, (box.height - pad * 2) / sheet.height_mm);
    fitScale.current = scale;
    view.current = {
      scale,
      x: (box.width - sheet.width_mm * scale) / 2,
      y: (box.height - sheet.height_mm * scale) / 2,
    };
    paint();
  }, [sheet.width_mm, sheet.height_mm, paint]);

  // Fit before the first paint (no visible jump) and whenever the frame resizes.
  useLayoutEffect(() => {
    fit();
    const element = frame.current;
    if (!element) return;
    let last = { width: 0, height: 0 };
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      if (width === last.width && height === last.height) return;
      last = { width, height };
      fit();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fit, sheet.sheet_id]);

  useEffect(() => () => cancelAnimationFrame(frameRequest.current), []);

  const zoomAt = useCallback(
    (factor: number, at?: { x: number; y: number }) => {
      const box = frame.current?.getBoundingClientRect();
      if (!box) return;
      const current = view.current;
      const scale = Math.min(
        Math.max(current.scale * factor, fitScale.current * MIN_ZOOM),
        fitScale.current * MAX_ZOOM,
      );
      const px = at?.x ?? box.width / 2;
      const py = at?.y ?? box.height / 2;
      const ratio = scale / current.scale;
      view.current = { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio };
      paint();
    },
    [paint],
  );

  // React's wheel listener is passive; a native one can stop the page scrolling.
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      zoomAt(Math.exp(-event.deltaY * 0.0015), { x: event.clientX - box.left, y: event.clientY - box.top });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const pan = (dx: number, dy: number) => {
    view.current = { ...view.current, x: view.current.x + dx, y: view.current.y + dy };
    paint();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = 60;
    const actions: Record<string, () => void> = {
      "+": () => zoomAt(1.25),
      "=": () => zoomAt(1.25),
      "-": () => zoomAt(0.8),
      "0": fit,
      ArrowLeft: () => pan(step, 0),
      ArrowRight: () => pan(-step, 0),
      ArrowUp: () => pan(0, step),
      ArrowDown: () => pan(0, -step),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  return (
    <div
      ref={frame}
      tabIndex={0}
      role="region"
      aria-roledescription="sheet viewer"
      aria-label={`${label}. Scroll or press plus and minus to zoom, drag or use the arrow keys to pan, 0 to fit.`}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY, view: view.current };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) return;
        view.current = { ...start.view, x: start.view.x + event.clientX - start.x, y: start.view.y + event.clientY - start.y };
        paint();
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={fit}
      className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden border bg-ws-surface select-none active:cursor-grabbing"
    >
      <div
        ref={stage}
        className="absolute top-0 left-0 origin-top-left text-ws-ink"
        style={{ width: sheet.width_mm, height: sheet.height_mm }}
      >
        {/* The sheet itself: a light steel plate in both themes so part colours read the same. */}
        <div className="absolute inset-0 bg-[#f3f4f3] shadow-[0_0_0_1px_rgb(22_25_28/0.55)] dark:bg-[#2a3034] dark:shadow-[0_0_0_1px_rgb(230_233_234/0.35)]" />
        <Parts sheet={sheet} looks={looks} />
        <Guides sheet={sheet} looks={looks} margins={margins} boxes={boxes} />
      </div>
      <div className="absolute top-2 right-2 flex gap-1" onPointerDown={(event) => event.stopPropagation()}>
        <Button variant="outline" size="icon-sm" className="bg-ws-panel" aria-label="Zoom in" onClick={() => zoomAt(1.4)}>
          <Plus />
        </Button>
        <Button variant="outline" size="icon-sm" className="bg-ws-panel" aria-label="Zoom out" onClick={() => zoomAt(1 / 1.4)}>
          <Minus />
        </Button>
        <Button variant="outline" size="icon-sm" className="bg-ws-panel" aria-label="Fit sheet" onClick={fit}>
          <Maximize2 />
        </Button>
      </div>
    </div>
  );
}
