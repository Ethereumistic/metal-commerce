import { useEffect, useRef, useState, type ReactNode } from "react";
import { ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { m } from "@/paraglide/messages";

const SCALE = 2.25;
type Point = { x: number; y: number };

export function ZoomablePhoto({
  src,
  alt,
  unavailable,
  onError,
  controls,
}: {
  src: string;
  alt: string;
  unavailable: boolean;
  onError: () => void;
  controls: ReactNode;
}) {
  const frame = useRef<HTMLButtonElement>(null);
  const drag = useRef<{
    pointerId: number;
    start: Point;
    pan: Point;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const [zoomed, setZoomed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState({ width: 1, height: 1 });

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = Math.min(
    size.width / natural.width,
    size.height / natural.height,
  );
  const limitX = Math.max(0, (natural.width * fit * SCALE - size.width) / 2);
  const limitY = Math.max(0, (natural.height * fit * SCALE - size.height) / 2);
  const clamp = (point: Point): Point => ({
    x: Math.max(-limitX, Math.min(limitX, point.x)),
    y: Math.max(-limitY, Math.min(limitY, point.y)),
  });
  const position = clamp(pan);
  const toggle = () => {
    setPan({ x: 0, y: 0 });
    setZoomed((value) => !value);
  };

  return (
    <>
      <div className="lightbox-stage">
        <button
          ref={frame}
          type="button"
          className="lightbox-photo"
          data-zoomed={zoomed || undefined}
          data-dragging={dragging || undefined}
          disabled={unavailable}
          aria-label={zoomed ? m.gallery_zoom_out() : m.gallery_zoom_in()}
          onClick={(event) => {
            if (suppressClick.current) {
              suppressClick.current = false;
              return;
            }
            if (zoomed) {
              toggle();
              return;
            }
            const bounds = event.currentTarget.getBoundingClientRect();
            setPan(
              event.detail === 0
                ? { x: 0, y: 0 }
                : clamp({
                    x:
                      (1 - SCALE) *
                      (event.clientX - bounds.left - bounds.width / 2),
                    y:
                      (1 - SCALE) *
                      (event.clientY - bounds.top - bounds.height / 2),
                  }),
            );
            setZoomed(true);
          }}
          onPointerDown={(event) => {
            if (!zoomed || !event.isPrimary || event.button !== 0) return;
            suppressClick.current = false;
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              pointerId: event.pointerId,
              start: { x: event.clientX, y: event.clientY },
              pan: position,
              moved: false,
            };
          }}
          onPointerMove={(event) => {
            const active = drag.current;
            if (!active || active.pointerId !== event.pointerId) return;
            const dx = event.clientX - active.start.x,
              dy = event.clientY - active.start.y;
            if (Math.hypot(dx, dy) > 4) active.moved = true;
            if (active.moved) {
              setDragging(true);
              setPan(clamp({ x: active.pan.x + dx, y: active.pan.y + dy }));
            }
          }}
          onPointerUp={(event) => {
            const active = drag.current;
            if (!active || active.pointerId !== event.pointerId) return;
            suppressClick.current = active.moved;
            drag.current = null;
            setDragging(false);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            drag.current = null;
            suppressClick.current = true;
            setDragging(false);
          }}
          onLostPointerCapture={() => {
            drag.current = null;
            setDragging(false);
          }}
        >
          {unavailable ? (
            <span className="gallery-empty">{m.image_unavailable()}</span>
          ) : (
            <img
              src={src}
              alt={alt}
              draggable={false}
              decoding="async"
              onLoad={(event) =>
                setNatural({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              onError={onError}
              style={{
                transform: zoomed
                  ? `translate(${position.x}px, ${position.y}px) scale(${SCALE})`
                  : "translate(0, 0) scale(1)",
              }}
            />
          )}
        </button>
      </div>
      <div className="lightbox-toolbar">
        {controls}
        <Button
          variant="ghost"
          disabled={unavailable}
          aria-pressed={zoomed}
          onClick={toggle}
        >
          {zoomed ? <ZoomOut size={18} /> : <ZoomIn size={18} />}
          {zoomed ? m.gallery_zoom_out() : m.gallery_zoom_in()}
        </Button>
      </div>
    </>
  );
}
