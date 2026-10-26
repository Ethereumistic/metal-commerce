import { memo, useState } from "react";
import { ImageOff } from "lucide-react";
import { cn } from "@workspace/ui/lib/utils";
import { artifactUrl } from "./api";
import { useProduction } from "./store";

/**
 * A product's picture: the catalog thumbnail, else the master's solid cut
 * shape (or overlay) when that master is loaded, else a placeholder. Images
 * load lazily and a broken one falls through to the next source.
 */
export const ProductImage = memo(function ProductImage({
  thumbnail,
  masterId,
  name,
  className,
}: {
  thumbnail: string | null;
  masterId?: string | null;
  /** For the hover title; the image itself is decorative next to the name. */
  name?: string;
  className?: string;
}) {
  const traced = useProduction((state) => {
    const artifacts = masterId ? state.masters[masterId]?.artifacts : undefined;
    return artifacts?.solid_png ?? artifacts?.overlay_png ?? null;
  });
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const sources = [thumbnail, traced ? artifactUrl(traced) : null].filter(
    (source): source is string => !!source && !broken.has(source),
  );
  const src = sources[0];
  return (
    <div
      title={name}
      className={cn(
        "flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted",
        className,
      )}
    >
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-full object-contain"
          onError={() => setBroken((current) => new Set(current).add(src))}
        />
      ) : (
        <ImageOff className="size-1/3 text-muted-foreground" aria-label="No image" />
      )}
    </div>
  );
});
