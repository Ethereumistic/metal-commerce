import { useEffect, useState } from "react";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@workspace/ui/components/combobox";
import { loadCatalog, type CatalogFont } from "../fonts";
import type { FontRef } from "../model";

export function useCatalog() {
  const [catalog, setCatalog] = useState<CatalogFont[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    loadCatalog()
      .then((fonts) => active && setCatalog(fonts))
      .catch(() => active && setError(true));
    return () => {
      active = false;
    };
  }, []);
  return { catalog, error };
}

/** Picks the closest available variant when switching families. */
export function fontFor(entry: CatalogFont, current: FontRef): FontRef {
  const weight = entry.weights.reduce((best, weight) =>
    Math.abs(weight - current.weight) < Math.abs(best - current.weight) ? weight : best,
  );
  return {
    id: entry.id,
    family: entry.family,
    weight,
    style: entry.styles.includes(current.style) ? current.style : entry.styles[0] ?? "normal",
    subset: entry.subsets.includes(current.subset) ? current.subset : entry.defSubset,
  };
}

export function FontPicker({
  value,
  catalog,
  onChange,
}: {
  value: FontRef;
  catalog: CatalogFont[] | null;
  onChange: (entry: CatalogFont) => void;
}) {
  const selected =
    catalog?.find((entry) => entry.id === value.id) ??
    ({ id: value.id, family: value.family } as CatalogFont);
  return (
    <Combobox
      items={catalog ?? []}
      value={selected}
      limit={80}
      itemToStringLabel={(entry: CatalogFont) => entry.family}
      isItemEqualToValue={(a: CatalogFont, b: CatalogFont) => a.id === b.id}
      onValueChange={(entry) => {
        if (entry) onChange(entry as CatalogFont);
      }}
    >
      <ComboboxInput placeholder={catalog ? "Search Google Fonts…" : "Loading fonts…"} />
      <ComboboxContent>
        <ComboboxEmpty>No fonts found.</ComboboxEmpty>
        <ComboboxList>
          {(entry: CatalogFont) => (
            <ComboboxItem key={entry.id} value={entry}>
              <span className="flex-1 truncate">{entry.family}</span>
              <span className="text-xs text-muted-foreground">{entry.category}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
