import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { buttonVariants } from "@workspace/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import { Segmented } from "../studio/components/fields";
import { artifactUrl, getMaster } from "./api";
import type { Master, ServiceResult } from "./contracts";
import { attempt } from "./hooks";
import { ResultAlert } from "./status";
import { useProduction } from "./store";

/** Fetches a master once and keeps it in the workspace store. */
export function useMaster(masterId: string | null) {
  const cached = useProduction((state) => (masterId ? state.masters[masterId] : undefined));
  const setMaster = useProduction((state) => state.setMaster);
  const [failure, setFailure] = useState<ServiceResult<Master> | null>(null);
  useEffect(() => {
    if (!masterId || cached) return;
    let active = true;
    setFailure(null);
    void attempt(() => getMaster({ data: { id: masterId } })).then((result) => {
      if (!active) return;
      if (result.ok) setMaster(result.data);
      else setFailure(result);
    });
    return () => {
      active = false;
    };
  }, [masterId, cached, setMaster]);
  return { master: cached ?? null, failure };
}

type View = "overlay" | "solid";

/** The traced master over its source image (overlay) or as the solid cut shape. */
export function TracePreview({ masterId }: { masterId: string }) {
  const { master, failure } = useMaster(masterId);
  const [view, setView] = useState<View>("overlay");
  if (failure) return <ResultAlert result={failure} title="Master unavailable" />;
  if (!master)
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> Loading master…
      </div>
    );
  const image = view === "overlay" ? master.artifacts.overlay_png : master.artifacts.solid_png;
  return (
    <div className="flex flex-col gap-3">
      <Segmented
        className="w-auto self-start"
        value={view}
        options={[
          { value: "overlay", label: "Overlay on source" },
          { value: "solid", label: "Solid cut shape" },
        ]}
        onChange={setView}
      />
      <div className="flex aspect-square max-h-[55vh] items-center justify-center overflow-hidden rounded-lg border bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px]">
        {image ? (
          <img
            src={artifactUrl(image)}
            alt={view === "overlay" ? "Traced contours over the source image" : "Solid cut shape"}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <p className="text-sm text-muted-foreground">No {view} preview was produced.</p>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
        <Fact label="Revision" value={master.revision} />
        <Fact label="Aspect ratio (w/h)" value={master.aspect_ratio.toFixed(4)} />
        <Fact label="Components" value={master.components} />
        <Fact label="Holes" value={master.holes} />
        <Fact label="Vertices" value={master.vertex_count} />
        <Fact label="Tracer" value={`${master.trace_engine} ${master.trace_version}`} />
        {master.diagnostics.threshold != null && (
          <Fact label="Threshold" value={master.diagnostics.threshold} />
        )}
        {master.diagnostics.noise_removed_area_px != null && (
          <Fact label="Noise removed" value={`${master.diagnostics.noise_removed_area_px} px²`} />
        )}
      </dl>
      {master.diagnostics.warnings.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-amber-600 dark:text-amber-400">
          {master.diagnostics.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      {master.artifacts.master_svg && (
        <a
          href={artifactUrl(master.artifacts.master_svg)}
          download
          className={buttonVariants({ variant: "outline", size: "sm", className: "self-start" })}
        >
          <Download /> Master SVG
        </a>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

export function TracePreviewDialog({
  masterId,
  productName,
  onClose,
}: {
  masterId: string | null;
  productName: string;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!masterId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{productName}</DialogTitle>
          <DialogDescription>
            Traced from the product's first catalog image. Resizing uses this master; it is never
            retraced for a new size.
          </DialogDescription>
        </DialogHeader>
        {masterId && <TracePreview masterId={masterId} />}
      </DialogContent>
    </Dialog>
  );
}

/** Loads a master into the store without rendering anything (for stages that need aspect ratios). */
export function MasterLoader({ masterId }: { masterId: string }) {
  useMaster(masterId);
  return null;
}
