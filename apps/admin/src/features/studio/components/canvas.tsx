import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Maximize, Minus, Plus } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import {
  artboardShapeMarkup,
  layerBox,
  layerSize,
  layerTransform,
  type Resolved,
} from "../geometry";
import { useCutPreview, useResolvedLayers } from "../hooks";
import { round, scaleLayer, snapBox, snapTargets, type Guide } from "../layout";
import type { Layer } from "../model";
import { useActiveDocument, useStudio } from "../store";

const MARGIN = 56;
const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

type Handle = "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w" | "rotate";

type Gesture =
  | { type: "move"; id: string; start: DOMPoint; origin: { x: number; y: number }; moved: boolean }
  | { type: "scale"; id: string; start: DOMPoint; snapshot: Layer; moved: boolean }
  | { type: "resize"; id: string; start: DOMPoint; snapshot: Layer; axis: "x" | "y"; moved: boolean }
  | { type: "rotate"; id: string; snapshot: Layer; moved: boolean };

const LayerView = memo(function LayerView({
  layer,
  resolved,
}: {
  layer: Layer;
  resolved: Resolved;
}) {
  return (
    <g
      transform={layerTransform(layer, resolved)}
      color={layer.color}
      opacity={layer.opacity < 1 ? layer.opacity : undefined}
      pointerEvents="none"
      dangerouslySetInnerHTML={{ __html: resolved.markup }}
    />
  );
});

/** Converts a client point into layer-local, unrotated coordinates around its centre. */
function toLocal(layer: Layer, point: { x: number; y: number }) {
  const angle = (-layer.rotation * Math.PI) / 180;
  const dx = point.x - layer.x;
  const dy = point.y - layer.y;
  return {
    x: dx * Math.cos(angle) - dy * Math.sin(angle),
    y: dx * Math.sin(angle) + dy * Math.cos(angle),
  };
}

export function Canvas() {
  const doc = useActiveDocument();
  const selectedId = useStudio((state) => state.selectedId);
  const view = useStudio((state) => state.view);
  const { select, updateLayer, checkpoint, setView } = useStudio.getState();
  const resolved = useResolvedLayers(doc);
  const cut = useCutPreview(doc);
  const { artboard } = doc;

  const viewportRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [guides, setGuides] = useState<Guide[]>([]);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fitZoom = Math.max(
    0.05,
    Math.min(
      (viewport.width - MARGIN * 2) / artboard.width,
      (viewport.height - MARGIN * 2) / artboard.height,
    ),
  );
  const zoom = view.zoom === "fit" ? fitZoom : view.zoom;
  const unit = 1 / zoom; // one screen pixel in artboard units

  const setZoom = useCallback(
    (direction: 1 | -1) => {
      const current = useStudio.getState().view.zoom;
      const value = current === "fit" ? fitZoom : current;
      const next =
        direction > 0
          ? ZOOM_STEPS.find((step) => step > value + 0.001)
          : [...ZOOM_STEPS].reverse().find((step) => step < value - 0.001);
      if (next) setView({ zoom: next });
    },
    [fitZoom, setView],
  );

  // Ctrl/⌘ + wheel zooms the canvas instead of the page.
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom(event.deltaY < 0 ? 1 : -1);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [setZoom]);

  function point(event: React.PointerEvent) {
    const svg = svgRef.current!;
    return new DOMPoint(event.clientX, event.clientY).matrixTransform(
      svg.getScreenCTM()!.inverse(),
    );
  }

  function hitTest(at: DOMPoint) {
    const hits = doc.layers.filter((layer) => {
      const r = resolved.get(layer.id);
      if (!layer.visible || !r) return false;
      const local = toLocal(layer, at);
      const { width, height } = layerSize(r);
      const slop = 4 * unit;
      return Math.abs(local.x) <= width / 2 + slop && Math.abs(local.y) <= height / 2 + slop;
    });
    // Keep the current selection when it is under the pointer (drag what you see selected).
    return hits.find((layer) => layer.id === selectedId) ?? hits.at(-1) ?? null;
  }

  function onPointerDown(event: React.PointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    const at = point(event);
    const layer = hitTest(at);
    select(layer?.id ?? null);
    if (!layer || layer.locked) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      type: "move",
      id: layer.id,
      start: at,
      origin: { x: layer.x, y: layer.y },
      moved: false,
    };
  }

  function onHandleDown(event: React.PointerEvent, handle: Handle, layer: Layer) {
    if (event.button !== 0 || layer.locked) return;
    event.stopPropagation();
    svgRef.current!.setPointerCapture(event.pointerId);
    const snapshot = JSON.parse(JSON.stringify(layer)) as Layer;
    const start = point(event);
    gesture.current =
      handle === "rotate"
        ? { type: "rotate", id: layer.id, snapshot, moved: false }
        : handle.length === 1
          ? {
              type: "resize",
              id: layer.id,
              start,
              snapshot,
              axis: handle === "e" || handle === "w" ? "x" : "y",
              moved: false,
            }
          : { type: "scale", id: layer.id, start, snapshot, moved: false };
  }

  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const current = gesture.current;
    if (!current) return;
    const at = point(event);
    if (!current.moved) {
      checkpoint();
      current.moved = true;
    }

    if (current.type === "move") {
      let dx = at.x - current.start.x;
      let dy = at.y - current.start.y;
      if (event.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
      const layer = doc.layers.find((item) => item.id === current.id);
      const r = layer && resolved.get(layer.id);
      if (!layer || !r) return;
      let next = { x: current.origin.x + dx, y: current.origin.y + dy };
      let nextGuides: Guide[] = [];
      if (view.snapping && !event.altKey) {
        const box = layerBox({ ...layer, ...next }, r);
        const others = doc.layers
          .filter((item) => item.id !== layer.id && item.visible)
          .flatMap((item) => {
            const other = resolved.get(item.id);
            return other ? [layerBox(item, other)] : [];
          });
        const snap = snapBox(box, snapTargets(artboard, others), 6 * unit);
        next = { x: next.x + snap.dx, y: next.y + snap.dy };
        nextGuides = snap.guides;
      }
      setGuides(nextGuides);
      updateLayer(
        current.id,
        (target) => {
          target.x = round(next.x);
          target.y = round(next.y);
        },
        { history: false },
      );
      return;
    }

    const base = current.snapshot;
    if (current.type === "scale") {
      const startDistance = Math.hypot(current.start.x - base.x, current.start.y - base.y);
      const distance = Math.hypot(at.x - base.x, at.y - base.y);
      if (startDistance < 1e-6) return;
      const factor = Math.max(0.01, distance / startDistance);
      updateLayer(
        current.id,
        (target) => {
          Object.assign(target, JSON.parse(JSON.stringify(base)));
          scaleLayer(target, factor);
        },
        { history: false },
      );
      return;
    }

    if (current.type === "resize" && base.kind === "shape") {
      const local = toLocal(base, at);
      const extent = Math.max(1, Math.abs(current.axis === "x" ? local.x : local.y) * 2);
      updateLayer(
        current.id,
        (target) => {
          if (target.kind !== "shape") return;
          if (current.axis === "x") target.width = round(extent);
          else target.height = round(extent);
        },
        { history: false },
      );
      return;
    }

    if (current.type === "rotate") {
      let angle = (Math.atan2(at.y - base.y, at.x - base.x) * 180) / Math.PI + 90;
      if (event.shiftKey) angle = Math.round(angle / 15) * 15;
      angle = ((angle % 360) + 540) % 360 - 180;
      updateLayer(current.id, (target) => void (target.rotation = round(angle)), {
        history: false,
      });
    }
  }

  function onPointerUp() {
    gesture.current = null;
    setGuides([]);
  }

  const selected = doc.layers.find((layer) => layer.id === selectedId);
  const selectedResolved = selected ? resolved.get(selected.id) : null;
  const clipId = "studio-artboard-clip";
  const handleSize = 9 * unit;

  return (
    // The canvas backdrop stays light in every theme so artwork colours read true.
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-neutral-100 [color-scheme:light]">
      <div
        ref={viewportRef}
        className="min-h-0 flex-1 overflow-auto"
        style={{
          backgroundImage:
            "radial-gradient(circle, rgb(0 0 0 / 0.12) 1px, transparent 1px)",
          backgroundSize: "16px 16px",
        }}
      >
        <div
          className="flex items-center justify-center"
          style={{
            minWidth: "100%",
            minHeight: "100%",
            width: artboard.width * zoom + MARGIN * 2,
            height: artboard.height * zoom + MARGIN * 2,
          }}
        >
          <svg
            ref={svgRef}
            width={artboard.width * zoom}
            height={artboard.height * zoom}
            viewBox={`0 0 ${artboard.width} ${artboard.height}`}
            overflow="visible"
            className="shrink-0 touch-none select-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            role="img"
            aria-label={`${doc.name} canvas`}
          >
            <defs>
              <pattern id="studio-checker" width={16 * unit} height={16 * unit} patternUnits="userSpaceOnUse">
                <rect width={16 * unit} height={16 * unit} fill="#ffffff" />
                <rect width={8 * unit} height={8 * unit} fill="#e5e5e5" />
                <rect x={8 * unit} y={8 * unit} width={8 * unit} height={8 * unit} fill="#e5e5e5" />
              </pattern>
              <clipPath
                id={clipId}
                dangerouslySetInnerHTML={{ __html: artboardShapeMarkup(artboard, "") }}
              />
            </defs>

            {/* Artboard background: real fill when exported, checkerboard when transparent. */}
            <g
              style={{ filter: "drop-shadow(0 1px 3px rgb(0 0 0 / 0.25))" }}
              dangerouslySetInnerHTML={{
                __html: artboardShapeMarkup(
                  artboard,
                  ` fill="${artboard.backgroundVisible ? artboard.background : "url(#studio-checker)"}"`,
                ),
              }}
            />

            <g clipPath={artboard.clip ? `url(#${clipId})` : undefined}>
              {doc.layers.map((layer) => {
                const r = resolved.get(layer.id);
                return layer.visible && r ? (
                  <LayerView key={layer.id} layer={layer} resolved={r} />
                ) : null;
              })}
              {/* Laser bridges: metal kept across cuts so islands stay attached. */}
              {cut.bridges && (
                <path d={cut.bridges} fill={artboard.background} pointerEvents="none" />
              )}
            </g>

            {/* Editor overlay — never exported. */}
            <g pointerEvents="none" fill="none" strokeWidth={1} vectorEffect="non-scaling-stroke">
              {view.showGuides && artboard.padding > 0 && (
                <g
                  stroke="#38bdf8"
                  strokeDasharray={`${4 * unit} ${4 * unit}`}
                  opacity={0.8}
                  dangerouslySetInnerHTML={{
                    __html: artboardShapeMarkup(
                      {
                        ...artboard,
                        width: artboard.width - artboard.padding * 2,
                        height: artboard.height - artboard.padding * 2,
                        cornerRadius: Math.max(0, artboard.cornerRadius - artboard.padding),
                      },
                      ` transform="translate(${artboard.padding} ${artboard.padding})" vector-effect="non-scaling-stroke"`,
                    ),
                  }}
                />
              )}
              {view.showGuides && (
                <g stroke="#38bdf8" opacity={0.35}>
                  <line x1={artboard.width / 2} x2={artboard.width / 2} y1={0} y2={artboard.height} vectorEffect="non-scaling-stroke" />
                  <line y1={artboard.height / 2} y2={artboard.height / 2} x1={0} x2={artboard.width} vectorEffect="non-scaling-stroke" />
                </g>
              )}
              {guides.map((guide) =>
                guide.axis === "x" ? (
                  <line key={`x${guide.value}`} x1={guide.value} x2={guide.value} y1={-artboard.height} y2={artboard.height * 2} stroke="#f43f5e" vectorEffect="non-scaling-stroke" />
                ) : (
                  <line key={`y${guide.value}`} y1={guide.value} y2={guide.value} x1={-artboard.width} x2={artboard.width * 2} stroke="#f43f5e" vectorEffect="non-scaling-stroke" />
                ),
              )}
            </g>

            {selected && selectedResolved && selected.visible && (
              <SelectionFrame
                layer={selected}
                resolved={selectedResolved}
                unit={unit}
                handleSize={handleSize}
                onHandleDown={onHandleDown}
              />
            )}
          </svg>
        </div>
      </div>

      <div className="pointer-events-none absolute right-3 bottom-3 flex items-center gap-1 rounded-lg border bg-background/95 p-1 shadow-sm backdrop-blur">
        <Button className="pointer-events-auto" size="icon-sm" variant="ghost" onClick={() => setZoom(-1)} aria-label="Zoom out">
          <Minus />
        </Button>
        <button
          type="button"
          className="pointer-events-auto w-12 text-center text-xs tabular-nums"
          onClick={() => setView({ zoom: 1 })}
          title="Reset to 100%"
        >
          {Math.round(zoom * 100)}%
        </button>
        <Button className="pointer-events-auto" size="icon-sm" variant="ghost" onClick={() => setZoom(1)} aria-label="Zoom in">
          <Plus />
        </Button>
        <Button
          className="pointer-events-auto"
          size="icon-sm"
          variant={view.zoom === "fit" ? "secondary" : "ghost"}
          onClick={() => setView({ zoom: "fit" })}
          aria-label="Zoom to fit"
        >
          <Maximize />
        </Button>
      </div>
    </div>
  );
}

function SelectionFrame({
  layer,
  resolved,
  unit,
  handleSize,
  onHandleDown,
}: {
  layer: Layer;
  resolved: Resolved;
  unit: number;
  handleSize: number;
  onHandleDown: (event: React.PointerEvent, handle: Handle, layer: Layer) => void;
}) {
  const { width, height } = layerSize(resolved);
  const w = width / 2;
  const h = height / 2;
  const corners: [Handle, number, number][] = [
    ["nw", -w, -h],
    ["ne", w, -h],
    ["sw", -w, h],
    ["se", w, h],
  ];
  const sides: [Handle, number, number][] =
    layer.kind === "shape"
      ? [
          ["n", 0, -h],
          ["s", 0, h],
          ["e", w, 0],
          ["w", -w, 0],
        ]
      : [];
  const cursor: Record<Handle, string> = {
    nw: "nwse-resize",
    se: "nwse-resize",
    ne: "nesw-resize",
    sw: "nesw-resize",
    n: "ns-resize",
    s: "ns-resize",
    e: "ew-resize",
    w: "ew-resize",
    rotate: "grab",
  };
  const rotateY = -h - 24 * unit;
  return (
    <g transform={`translate(${layer.x} ${layer.y}) rotate(${layer.rotation})`}>
      <rect
        x={-w}
        y={-h}
        width={width}
        height={height}
        fill="none"
        stroke={layer.locked ? "#a3a3a3" : "#2563eb"}
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
        pointerEvents="none"
      />
      {!layer.locked && (
        <>
          <line x1={0} x2={0} y1={-h} y2={rotateY} stroke="#2563eb" vectorEffect="non-scaling-stroke" pointerEvents="none" />
          <circle
            cx={0}
            cy={rotateY}
            r={handleSize / 2}
            fill="#ffffff"
            stroke="#2563eb"
            vectorEffect="non-scaling-stroke"
            style={{ cursor: cursor.rotate }}
            onPointerDown={(event) => onHandleDown(event, "rotate", layer)}
          />
          {[...corners, ...sides].map(([handle, x, y]) => (
            <rect
              key={handle}
              x={x - handleSize / 2}
              y={y - handleSize / 2}
              width={handleSize}
              height={handleSize}
              fill="#ffffff"
              stroke="#2563eb"
              vectorEffect="non-scaling-stroke"
              style={{ cursor: cursor[handle] }}
              onPointerDown={(event) => onHandleDown(event, handle, layer)}
            />
          ))}
        </>
      )}
    </g>
  );
}
