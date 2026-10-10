import { useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, ArrowRight, Maximize2 } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import { ZoomablePhoto } from "@/components/zoomable-photo";
import type { StoreImage } from "@/lib/commerce";
import { m } from "@/paraglide/messages";

export function ProductGallery({
  images,
  name,
}: {
  images: StoreImage[];
  name: string;
}) {
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const choose = (next: number) => {
    setIndex((next + images.length) % images.length);
  };
  const keyboard = (event: KeyboardEvent) => {
    const next =
      event.key === "ArrowRight"
        ? index + 1
        : event.key === "ArrowLeft"
          ? index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? images.length - 1
              : null;
    if (next !== null) {
      event.preventDefault();
      event.stopPropagation();
      choose(next);
    }
  };
  const photograph = () =>
    failed.includes(images[index].detail) ? (
      <span className="gallery-empty">{m.image_unavailable()}</span>
    ) : (
      <img
        key={images[index].original}
        src={images[index].detail}
        srcSet={images[index].srcSet}
        sizes="(max-width: 900px) 100vw, 55vw"
        width={images[index].width}
        height={images[index].height}
        alt={images[index].alt || `${name} — ${m.gallery_view({ number: index + 1 })}`}
        fetchPriority="high"
        loading="eager"
        decoding="async"
        onError={() =>
          setFailed((previous) => [...previous, images[index].detail])
        }
      />
    );
  const controls = () => (
    <div className="gallery-controls">
      <Button
        variant="ghost"
        size="icon"
        disabled={images.length < 2}
        aria-label={m.gallery_previous()}
        onClick={() => choose(index - 1)}
      >
        <ArrowLeft size={18} />
      </Button>
      <span aria-live="polite" aria-atomic="true">
        {String(index + 1).padStart(2, "0")}{" "}
        <span>/ {String(images.length).padStart(2, "0")}</span>
      </span>
      <Button
        variant="ghost"
        size="icon"
        disabled={images.length < 2}
        aria-label={m.gallery_next()}
        onClick={() => choose(index + 1)}
      >
        <ArrowRight size={18} />
      </Button>
    </div>
  );
  const thumbnails = () => (
    <div className="gallery-thumbnails" aria-label={m.gallery_views()}>
      {images.map((url, i) => (
        <button
          key={`${url.original}-${i}`}
          type="button"
          aria-label={m.gallery_view({ number: i + 1 })}
          aria-pressed={i === index}
          onClick={() => choose(i)}
        >
          <img
            src={url.thumbnail}
            width={url.width}
            height={url.height}
            alt=""
            loading="lazy"
            decoding="async"
          />
        </button>
      ))}
    </div>
  );
  if (!images.length)
    return <div className="gallery-empty">{m.image_unavailable()}</div>;
  return (
    <div className="product-gallery-set" onKeyDown={keyboard}>
      <div className="gallery-layout">
        {thumbnails()}
        <div
          className="gallery-stage"
          onTouchStart={(event) => {
            touch.current = {
              x: event.touches[0].clientX,
              y: event.touches[0].clientY,
            };
          }}
          onTouchEnd={(event) => {
            const start = touch.current;
            touch.current = null;
            if (!start) return;
            const dx = event.changedTouches[0].clientX - start.x,
              dy = event.changedTouches[0].clientY - start.y;
            if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5)
              choose(index + (dx < 0 ? 1 : -1));
          }}
        >
          <button
            type="button"
            className="gallery-open"
            aria-label={m.zoom()}
            onClick={() => setOpen(true)}
          >
            {photograph()}
            <span className="gallery-expand">
              <Maximize2 size={18} />
            </span>
          </button>
        </div>
      </div>
      {images[index].credit && (
        <p className="gallery-credit">
          <a href={images[index].credit.url} target="_blank" rel="noreferrer">
            {images[index].credit.name}
          </a>
        </p>
      )}
      <div className="gallery-toolbar">
        <span>{m.gallery_views()}</span>
        {controls()}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel={m.close()} className="product-lightbox" onKeyDown={keyboard}>
          <div className="lightbox-heading">
            <DialogTitle>{name}</DialogTitle>
            <DialogDescription>{m.gallery_views()}</DialogDescription>
          </div>
          <ZoomablePhoto
            key={images[index].original}
            src={images[index].original}
            alt={images[index].alt || `${name} — ${m.gallery_view({ number: index + 1 })}`}
            unavailable={failed.includes(images[index].original)}
            onError={() =>
              setFailed((previous) => [...previous, images[index].original])
            }
            controls={controls()}
          />
          {thumbnails()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
