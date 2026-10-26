import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Eye, Loader2, RefreshCw, Search, Wand2, X } from "lucide-react";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { useShallow } from "zustand/react/shallow";
import { getJobs, getMaster, listProducts, prepareProducts } from "./api";
import { newLine } from "./batch-logic";
import { Checkbox } from "./checkbox";
import type {
  CatalogCard,
  CatalogPage,
  Master,
  PreparationItem,
  ServiceResult,
} from "./contracts";
import { attempt, backoff, useActionKey, usePolling } from "./hooks";
import { ProductImage } from "./product-image";
import { ErrorText, OfflineAlert, PreparationBadge, ResultAlert } from "./status";
import { useProduction, type PendingAdd, type SelectedProduct } from "./store";
import { TracePreviewDialog } from "./trace-preview";

const PREPARE_LIMIT = 50;
const ACTIVE = new Set(["queued", "processing"]);

function activeTraces(preparation: Record<string, PreparationItem>) {
  return Object.values(preparation).filter(
    (item): item is PreparationItem & { job_id: string } => ACTIVE.has(item.status) && !!item.job_id,
  );
}

/** Polls the service for trace jobs until each finishes, then records the master or the error. */
function usePreparationJobs() {
  const preparation = useProduction((state) => state.preparation);
  const pending = useMemo(() => activeTraces(preparation), [preparation]);
  const key = pending.map((item) => item.job_id).join(",");
  const delay = useRef(2_000);
  const setOffline = useProduction((state) => state.setTracePollOffline);
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
}

/** Fetches a master, using the copy already in the store when there is one. */
async function loadMaster(masterId: string): Promise<ServiceResult<Master>> {
  const cached = useProduction.getState().masters[masterId];
  if (cached) return { ok: true, data: cached };
  const result = await attempt(() => getMaster({ data: { id: masterId } }));
  if (result.ok) useProduction.getState().setMaster(result.data);
  return result;
}

const readyMaster = (productId: string) => {
  const item = useProduction.getState().preparation[productId];
  return item?.status === "ready" && item.master_id ? item.master_id : null;
};

const ADD_RETRY_MS = 10_000;

/**
 * Adds products that were waiting for their master to the batch as soon as
 * tracing finishes. Retries while the service cannot be reached.
 */
function usePendingAdds() {
  const ready = useProduction(
    useShallow((state) =>
      Object.keys(state.pendingAdds).filter((id) => {
        const item = state.preparation[id];
        return item?.status === "ready" && !!item.master_id;
      }),
    ),
  );
  const [retry, setRetry] = useState(0);
  const key = ready.join(",");
  useEffect(() => {
    if (!ready.length) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      for (const productId of ready) {
        const masterId = readyMaster(productId);
        const product = useProduction.getState().pendingAdds[productId];
        if (!masterId || !product) continue;
        const result = await loadMaster(masterId);
        if (!active) return;
        if (!result.ok) {
          timer = setTimeout(() => setRetry((value) => value + 1), ADD_RETRY_MS);
          return;
        }
        const { addLines, dropPendingAdd, lineDefaults } = useProduction.getState();
        addLines([newLine({ id: productId, name: product.name, thumbnail: product.thumbnail }, masterId, lineDefaults)]);
        // Already in the batch (added another way): nothing to add, stop waiting.
        dropPendingAdd(productId);
      }
    })();
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // `key` stands for `ready`.
  }, [key, retry]);
}

/**
 * Follows trace jobs the service accepted (including ones from before a
 * reload) and adds waiting products to the batch when they are ready. It
 * renders nothing, so its polling never re-renders the workspace.
 */
export function PreparationFollower() {
  usePreparationJobs();
  usePendingAdds();
  return null;
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

/** The search box keeps its own text so typing does not re-render the catalog list. */
function SearchBar({
  query,
  loading,
  onSearch,
  onReload,
}: {
  query: string;
  loading: boolean;
  onSearch: (value: string) => void;
  onReload: () => void;
}) {
  const [draft, setDraft] = useState(query);
  return (
    <form
      className="flex items-center gap-2 border-b p-3"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSearch(draft);
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
      {query && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setDraft("");
            onSearch("");
          }}
        >
          <X /> Clear search
        </Button>
      )}
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Reload catalog" onClick={onReload}>
        <RefreshCw className={loading ? "animate-spin" : undefined} />
      </Button>
    </form>
  );
}

const CatalogRow = memo(function CatalogRow({
  card,
  item,
  selected,
  onInspect,
}: {
  card: CatalogCard;
  item: PreparationItem | null;
  selected: boolean;
  onInspect: (target: { masterId: string; name: string }) => void;
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <Checkbox
        label={`Select ${card.name}`}
        checked={selected}
        onChange={(checked) => useProduction.getState().toggle(toSelected(card), checked)}
      />
      <ProductImage thumbnail={card.thumbnail} />
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
          onClick={() => onInspect({ masterId: item.master_id!, name: card.name })}
        >
          <Eye />
        </Button>
      )}
    </li>
  );
});

type ContinueNote = { tone: "info" | "error"; text: string };

export function ProductPicker({
  canEdit,
  onContinue,
}: {
  canEdit: boolean;
  /** Called once every selected product is in the batch or waiting for its master. */
  onContinue: () => void;
}) {
  const catalog = useCatalog();
  const selected = useProduction((state) => state.selected);
  const preparation = useProduction((state) => state.preparation);
  const pollOffline = useProduction((state) => state.tracePollOffline);
  const { toggle, clearSelection, setPreparation } = useProduction.getState();
  const prepareKey = useActionKey("prepare");
  const [prepareResult, setPrepareResult] = useState<ServiceResult<unknown> | null>(null);
  const [busy, setBusy] = useState<"prepare" | "continue" | null>(null);
  const [addFailure, setAddFailure] = useState<ServiceResult<unknown> | null>(null);
  const [note, setNote] = useState<ContinueNote | null>(null);
  const [inspect, setInspect] = useState<{ masterId: string; name: string } | null>(null);

  // The service's fresh answer (including "stale" after an image change)
  // replaces whatever this browser remembered for those products.
  useEffect(() => {
    const fresh = catalog.items.flatMap((card) => (card.preparation ? [card.preparation] : []));
    if (fresh.length) setPreparation(fresh);
  }, [catalog.items, setPreparation]);

  const chosen = Object.values(selected);
  const shown = catalog.items;
  const shownSelected = shown.filter((card) => selected[card.id]).length;
  const tracing = activeTraces(preparation).length;

  async function requestPreparation(products: SelectedProduct[], reprocess: boolean) {
    const payload = products.slice(0, PREPARE_LIMIT).map(({ id, slug }) => ({ id, slug }));
    const fingerprint = JSON.stringify({ products: payload, reprocess });
    const result = await attempt(() =>
      prepareProducts({
        data: { products: payload, reprocess, idempotencyKey: prepareKey.key(fingerprint) },
      }),
    );
    prepareKey.settle(result);
    setPrepareResult(result);
    if (result.ok) setPreparation(result.data.items);
    return result;
  }

  async function prepare(reprocess: boolean) {
    if (!chosen.length) return;
    setBusy("prepare");
    setNote(null);
    await requestPreparation(chosen, reprocess);
    setBusy(null);
  }

  /**
   * One step from a selection to batch rows: prepares what is not prepared,
   * adds ready products (never twice), and queues the ones still tracing so
   * they join the batch when ready. Stays here when anything failed.
   */
  async function continueToBatch() {
    const products = Object.values(useProduction.getState().selected);
    if (!products.length) return;
    setBusy("continue");
    setAddFailure(null);
    setNote(null);
    const statusOf = (id: string) => useProduction.getState().preparation[id]?.status;

    const unprepared = products.filter((product) => {
      const status = statusOf(product.id);
      return !(status === "ready" && readyMaster(product.id)) && !ACTIVE.has(status ?? "");
    });
    let skipped = 0;
    if (unprepared.length) {
      if (!canEdit) {
        setBusy(null);
        setNote({
          tone: "error",
          text: `${unprepared.length} selected product${unprepared.length === 1 ? " is" : "s are"} not prepared, and your role cannot prepare products.`,
        });
        return;
      }
      skipped = Math.max(0, unprepared.length - PREPARE_LIMIT);
      const result = await requestPreparation(unprepared, false);
      if (!result.ok) {
        setBusy(null);
        return;
      }
    }

    const ready: { product: SelectedProduct; masterId: string }[] = [];
    const waiting: PendingAdd[] = [];
    const failed: SelectedProduct[] = [];
    for (const product of products) {
      const masterId = readyMaster(product.id);
      const status = statusOf(product.id);
      if (masterId) ready.push({ product, masterId });
      else if (ACTIVE.has(status ?? ""))
        waiting.push({ productId: product.id, name: product.name, thumbnail: product.thumbnail });
      else failed.push(product);
    }

    const masters = await Promise.all(ready.map(({ masterId }) => loadMaster(masterId)));
    const { addLines, queueAdds, lineDefaults } = useProduction.getState();
    addLines(
      ready.flatMap(({ product }, index) =>
        masters[index]!.ok ? [newLine(product, ready[index]!.masterId, lineDefaults)] : [],
      ),
    );
    queueAdds(waiting);
    setBusy(null);

    const masterFailure = masters.find((result) => !result.ok);
    if (masterFailure) {
      setAddFailure(masterFailure);
      return;
    }
    const left = failed.length - skipped;
    if (failed.length) {
      setNote({
        tone: "error",
        text:
          skipped > 0
            ? `Only ${PREPARE_LIMIT} products are prepared per request; press Continue again for the remaining ${skipped}.`
            : `${left} product${left === 1 ? " was" : "s were"} not prepared (see the errors in the list). The others are in the batch.`,
      });
      return;
    }
    onContinue();
  }

  const onInspect = useCallback((target: { masterId: string; name: string }) => setInspect(target), []);
  const notReady = chosen.filter((product) => preparation[product.id]?.status !== "ready").length;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <SearchBar
          query={catalog.query}
          loading={catalog.loading}
          onSearch={catalog.search}
          onReload={() => void catalog.reload()}
        />

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
          {shown.map((card) => (
            <CatalogRow
              key={card.id}
              card={card}
              item={preparation[card.id] ?? card.preparation}
              selected={!!selected[card.id]}
              onInspect={onInspect}
            />
          ))}
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
              <ProductImage thumbnail={product.thumbnail} className="size-8" />
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
              Only the first {PREPARE_LIMIT} products are prepared per request.
            </p>
          )}
          {tracing > 0 && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Tracing {tracing} product{tracing === 1 ? "" : "s"}…
            </p>
          )}
          <ResultAlert result={prepareResult} title="Preparation was not accepted" />
          <ResultAlert result={addFailure} title="Could not add to batch" />
          {note && (
            <p className={note.tone === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"} role="status">
              {note.text}
            </p>
          )}
          {!canEdit && (
            <p className="text-xs text-muted-foreground">Your role can view production but not prepare products.</p>
          )}
          <Button disabled={!chosen.length || busy != null} onClick={() => void continueToBatch()}>
            {busy === "continue" ? <Loader2 className="animate-spin" /> : <ArrowRight />} Continue with{" "}
            {chosen.length} to batch
          </Button>
          {notReady > 0 && (
            <p className="text-xs text-muted-foreground">
              Products without a master are prepared first; ones still tracing join the batch when ready.
            </p>
          )}
          <div className="flex gap-2">
            <Button
              className="flex-1"
              variant="outline"
              size="sm"
              disabled={!canEdit || !chosen.length || busy != null}
              onClick={() => void prepare(false)}
            >
              {busy === "prepare" ? <Loader2 className="animate-spin" /> : <Wand2 />} Prepare only
            </Button>
            <Button
              className="flex-1"
              variant="outline"
              size="sm"
              disabled={!canEdit || !chosen.length || busy != null}
              onClick={() => void prepare(true)}
              title="Trace again as a new master revision; existing masters and batches are kept"
            >
              Reprocess
            </Button>
          </div>
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
