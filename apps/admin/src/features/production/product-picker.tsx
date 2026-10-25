import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Eye, ImageOff, Loader2, Plus, RefreshCw, Search, Wand2, X } from "lucide-react";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { getJobs, getMaster, listProducts, prepareProducts } from "./api";
import type {
  CatalogCard,
  CatalogPage,
  PreparationItem,
  ServiceResult,
} from "./contracts";
import { attempt, backoff, useActionKey, usePolling } from "./hooks";
import { ErrorText, OfflineAlert, PreparationBadge, ResultAlert } from "./status";
import { useProduction, type SelectedProduct } from "./store";
import { TracePreviewDialog } from "./trace-preview";

const PREPARE_LIMIT = 50;
const ACTIVE = new Set(["queued", "processing"]);

/** A styled native checkbox; the shared UI package has no checkbox primitive. */
export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
      className="size-4 shrink-0 cursor-pointer rounded border-input accent-primary disabled:cursor-not-allowed disabled:opacity-50"
    />
  );
}

function activeTraces(preparation: Record<string, PreparationItem>) {
  return Object.values(preparation).filter(
    (item): item is PreparationItem & { job_id: string } => ACTIVE.has(item.status) && !!item.job_id,
  );
}

/**
 * Follows trace jobs the service accepted (including ones from before a
 * reload) until each finishes, then records the master or the error.
 */
export function usePreparationJobs() {
  const preparation = useProduction((state) => state.preparation);
  const pending = useMemo(() => activeTraces(preparation), [preparation]);
  const key = pending.map((item) => item.job_id).join(",");
  const delay = useRef(2_000);
  const [offline, setOffline] = useState(false);
  usePolling(
    pending.length
      ? async () => {
          const current = activeTraces(useProduction.getState().preparation).slice(0, 50);
          if (!current.length) return null;
          const result = await attempt(() =>
            getJobs({ data: { ids: current.map((item) => item.job_id) } }),
          );
          if (!result.ok) {
            setOffline(result.offline);
            delay.current = backoff(delay.current, 30_000);
            return delay.current;
          }
          setOffline(false);
          const byJob = new Map(current.map((item) => [item.job_id, item]));
          const changed: PreparationItem[] = [];
          for (const id of result.data.missing) {
            const item = byJob.get(id);
            if (item)
              changed.push({
                ...item,
                status: "failed",
                error: { code: "NOT_FOUND", message: "The service no longer has this trace job. Prepare the product again." },
              });
          }
          for (const job of result.data.jobs) {
            const item = byJob.get(job.id);
            if (!item) continue;
            if (job.status === "succeeded" && job.result?.master_id)
              changed.push({ ...item, status: "ready", master_id: job.result.master_id, error: null });
            else if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled")
              changed.push({
                ...item,
                status: "failed",
                error: job.error ?? {
                  code: job.status === "cancelled" ? "CANCELLED" : "INVALID_RESPONSE",
                  message:
                    job.status === "cancelled"
                      ? "Tracing was cancelled."
                      : "The trace job ended without a master.",
                },
              });
            else if (job.status === "running" && item.status !== "processing")
              changed.push({ ...item, status: "processing" });
          }
          if (changed.length) useProduction.getState().setPreparation(changed);
          delay.current = changed.length ? 2_000 : backoff(delay.current, 10_000);
          return delay.current;
        }
      : null,
    [key],
  );
  return { tracing: pending.length, offline };
}

function useCatalog() {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<CatalogCard[]>([]);
  const [page, setPage] = useState<CatalogPage | null>(null);
  const [failure, setFailure] = useState<ServiceResult<CatalogPage> | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);

  const load = useCallback(async (search: string, cursor: string | null) => {
    const id = ++request.current;
    setLoading(true);
    const result = await attempt(() =>
      listProducts({ data: { search: search || undefined, cursor: cursor ?? undefined } }),
    );
    if (id !== request.current) return;
    setLoading(false);
    if (!result.ok) {
      setFailure(result);
      return;
    }
    setFailure(null);
    setPage(result.data);
    setItems((previous) => (cursor ? [...previous, ...result.data.items] : result.data.items));
  }, []);

  useEffect(() => {
    void load(query, null);
  }, [load, query]);

  return {
    query,
    search: (value: string) => setQuery(value.trim()),
    items,
    page,
    failure,
    loading,
    more: () => page?.cursor && load(query, page.cursor),
    reload: () => load(query, null),
  };
}

const toSelected = (card: CatalogCard): SelectedProduct => ({
  id: card.id,
  slug: card.slug,
  name: card.name,
  thumbnail: card.thumbnail,
  revision: card.revision,
});

export function ProductPicker({
  canEdit,
  tracing,
  pollOffline,
  onAddedToBatch,
}: {
  canEdit: boolean;
  /** From usePreparationJobs, which the workspace runs so tracing is followed on every stage. */
  tracing: number;
  pollOffline: boolean;
  onAddedToBatch: () => void;
}) {
  const catalog = useCatalog();
  const [draft, setDraft] = useState("");
  const selected = useProduction((state) => state.selected);
  const preparation = useProduction((state) => state.preparation);
  const { toggle, clearSelection, setPreparation, setMaster, addLine } = useProduction.getState();
  const prepareKey = useActionKey("prepare");
  const [prepareResult, setPrepareResult] = useState<ServiceResult<unknown> | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addFailure, setAddFailure] = useState<ServiceResult<unknown> | null>(null);
  const [inspect, setInspect] = useState<{ masterId: string; name: string } | null>(null);

  // The service's fresh answer (including "stale" after an image change)
  // replaces whatever this browser remembered for those products.
  useEffect(() => {
    const fresh = catalog.items.flatMap((card) => (card.preparation ? [card.preparation] : []));
    if (fresh.length) setPreparation(fresh);
  }, [catalog.items, setPreparation]);

  const status = (card: CatalogCard) => preparation[card.id] ?? card.preparation;
  const chosen = Object.values(selected);
  const shown = catalog.items;
  const shownSelected = shown.filter((card) => selected[card.id]).length;

  async function prepare(reprocess: boolean) {
    const products = chosen.slice(0, PREPARE_LIMIT).map(({ id, slug }) => ({ id, slug }));
    if (!products.length) return;
    const fingerprint = JSON.stringify({ products, reprocess });
    setPreparing(true);
    const result = await attempt(() =>
      prepareProducts({
        data: { products, reprocess, idempotencyKey: prepareKey.key(fingerprint) },
      }),
    );
    prepareKey.settle(result);
    setPreparing(false);
    setPrepareResult(result);
    if (result.ok) setPreparation(result.data.items);
  }

  async function addReady(products: SelectedProduct[]) {
    setAdding(true);
    setAddFailure(null);
    for (const product of products) {
      const item = useProduction.getState().preparation[product.id];
      if (item?.status !== "ready" || !item.master_id) continue;
      const result = await attempt(() => getMaster({ data: { id: item.master_id! } }));
      if (!result.ok) {
        setAddFailure(result);
        break;
      }
      setMaster(result.data);
      addLine({
        productId: product.id,
        productName: product.name,
        masterId: result.data.id,
        mode: "width",
        width: null,
        height: null,
        quantity: null,
        material: "",
        thickness: null,
        rotations: [0, 90, 180, 270],
      });
    }
    setAdding(false);
    onAddedToBatch();
  }

  const readyChosen = chosen.filter((product) => preparation[product.id]?.status === "ready");

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <form
          className="flex items-center gap-2 border-b p-3"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            catalog.search(draft);
          }}
        >
          <div className="relative max-w-md flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Search product names"
              maxLength={200}
              className="pl-8"
              aria-label="Search product names"
            />
          </div>
          <Button type="submit" variant="outline" size="sm">
            Search
          </Button>
          {catalog.query && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft("");
                catalog.search("");
              }}
            >
              <X /> Clear search
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Reload catalog"
            onClick={() => void catalog.reload()}
          >
            <RefreshCw className={catalog.loading ? "animate-spin" : undefined} />
          </Button>
        </form>

        <div className="flex items-center gap-3 border-b px-3 py-2 text-xs text-muted-foreground">
          <Checkbox
            label="Select all products shown"
            checked={shown.length > 0 && shownSelected === shown.length}
            indeterminate={shownSelected > 0 && shownSelected < shown.length}
            disabled={!shown.length}
            onChange={(checked) => shown.forEach((card) => toggle(toSelected(card), checked))}
          />
          <span>
            {catalog.page?.scope === "search"
              ? `Best ${shown.length} name matches for “${catalog.query}”. Search results are not paginated; refine the words to find others.`
              : `${shown.length} products loaded, all statuses including drafts, in route order.`}
            {" "}Select all applies to the products shown here only.
          </span>
        </div>

        <div className="flex flex-col gap-2 p-3 empty:hidden">
          <ResultAlert result={catalog.failure} title="Catalog unavailable" />
          {catalog.page?.statusOffline && (
            <OfflineAlert>
              Preparation statuses could not be loaded. The catalog is shown, but nothing can be
              prepared until the service is back.
            </OfflineAlert>
          )}
          {pollOffline && <OfflineAlert>Tracing progress will update when the service is back.</OfflineAlert>}
        </div>

        <ul className="min-h-0 flex-1 divide-y overflow-y-auto">
          {shown.map((card) => {
            const item = status(card);
            return (
              <li key={card.id} className="flex items-center gap-3 px-3 py-2">
                <Checkbox
                  label={`Select ${card.name}`}
                  checked={!!selected[card.id]}
                  onChange={(checked) => toggle(toSelected(card), checked)}
                />
                <Thumbnail card={card} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{card.name}</span>
                    {!card.published && <Badge variant="outline">Draft</Badge>}
                    {card.archived && <Badge variant="outline">Archived</Badge>}
                  </div>
                  <span className="truncate font-mono text-xs text-muted-foreground">{card.slug}</span>
                  {!card.firstImage.ok && <ErrorText error={card.firstImage.error} />}
                  {item?.error && <ErrorText error={item.error} />}
                </div>
                <PreparationBadge status={item?.status ?? null} />
                {item?.master_id && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Inspect the trace of ${card.name}`}
                    onClick={() => setInspect({ masterId: item.master_id!, name: card.name })}
                  >
                    <Eye />
                  </Button>
                )}
              </li>
            );
          })}
          {!shown.length && !catalog.loading && !catalog.failure && (
            <li className="p-6 text-center text-sm text-muted-foreground">No products found.</li>
          )}
        </ul>
        {catalog.page?.cursor && (
          <div className="border-t p-2 text-center">
            <Button variant="outline" size="sm" disabled={catalog.loading} onClick={() => void catalog.more()}>
              {catalog.loading && <Loader2 className="animate-spin" />} Load more
            </Button>
          </div>
        )}
      </div>

      <aside className="flex w-80 shrink-0 flex-col border-l">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Selected · {chosen.length}
          </h3>
          {chosen.length > 0 && (
            <Button variant="ghost" size="xs" onClick={clearSelection}>
              Clear
            </Button>
          )}
        </div>
        <ul className="min-h-0 flex-1 divide-y overflow-y-auto text-sm">
          {chosen.map((product) => (
            <li key={product.id} className="flex items-center gap-2 px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate">{product.name}</span>
              <PreparationBadge status={preparation[product.id]?.status ?? null} />
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${product.name} from the selection`}
                onClick={() => toggle(product, false)}
              >
                <X />
              </Button>
            </li>
          ))}
          {!chosen.length && (
            <li className="p-4 text-xs text-muted-foreground">
              Pick products on the left. The selection is kept across pages and searches.
            </li>
          )}
        </ul>
        <div className="flex flex-col gap-2 border-t p-3">
          {chosen.length > PREPARE_LIMIT && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Only the first {PREPARE_LIMIT} selected products are prepared per request.
            </p>
          )}
          {tracing > 0 && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Tracing {tracing} product{tracing === 1 ? "" : "s"}…
            </p>
          )}
          <ResultAlert result={prepareResult} title="Preparation was not accepted" />
          <ResultAlert result={addFailure} title="Could not add to batch" />
          {!canEdit && (
            <p className="text-xs text-muted-foreground">Your role can view production but not prepare products.</p>
          )}
          <Button disabled={!canEdit || !chosen.length || preparing} onClick={() => void prepare(false)}>
            {preparing ? <Loader2 className="animate-spin" /> : <Wand2 />} Prepare selected
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!canEdit || !chosen.length || preparing}
            onClick={() => void prepare(true)}
            title="Trace again as a new master revision; existing masters and batches are kept"
          >
            Reprocess selected
          </Button>
          <Button
            variant="secondary"
            disabled={!readyChosen.length || adding}
            onClick={() => void addReady(readyChosen)}
          >
            {adding ? <Loader2 className="animate-spin" /> : <Plus />} Add {readyChosen.length} ready to batch
          </Button>
        </div>
      </aside>

      <TracePreviewDialog
        masterId={inspect?.masterId ?? null}
        productName={inspect?.name ?? ""}
        onClose={() => setInspect(null)}
      />
    </div>
  );
}

function Thumbnail({ card }: { card: CatalogCard }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
      {card.thumbnail && !broken ? (
        <img
          src={card.thumbnail}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-full object-contain"
          onError={() => setBroken(true)}
        />
      ) : (
        <ImageOff className="size-5 text-muted-foreground" aria-label="No first image" />
      )}
    </div>
  );
}
