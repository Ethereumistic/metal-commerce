import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import {
  createPublicCatalogClient,
  CatalogError,
  type PublicCard,
  type PublicImage,
} from "@echoray/api-client/public-catalog";
import type {
  CategoryCatalog,
  ProductCatalog,
  ProductDetail,
  ProductFilters,
  StoreCard,
  StoreImage,
} from "./commerce";
import { categoryKey, backendCollection } from "./commerce-filters";

function catalog() {
  return createPublicCatalogClient({
    gatewayUrl: env.STOREFRONT_GATEWAY_URL,
    storefrontId: env.STOREFRONT_PUBLIC_INTEGRATION_ID,
    onDiagnostics: ({ cache, environment, originMs }) => {
      console.info(
        JSON.stringify({
          event: "metal_craft_catalog",
          adapter: "gateway",
          cache,
          environment,
          originMs,
        }),
      );
    },
  });
}
function directEnabled() {
  if (!["gateway", "direct"].includes(env.STOREFRONT_CATALOG_ADAPTER))
    throw new Error("Invalid catalog adapter");
  return String(env.STOREFRONT_CATALOG_ADAPTER) === "direct";
}
function failure(error: unknown) {
  const known = error instanceof CatalogError;
  const errorCode = known ? error.code : "UNAVAILABLE";
  console.warn(
    JSON.stringify({ event: "metal_craft_catalog_error", code: errorCode }),
  );
  return {
    errorCode,
    retryAfterSeconds: known ? error.retryAfterSeconds : null,
  };
}
function displayUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Invalid display URL");
  return url.href;
}
function image(
  value: PublicImage,
  client: ReturnType<typeof catalog>,
): StoreImage {
  const candidates = value.derivatives.map((d) => ({
    url: client.imageUrl(value, d.preset),
    width: d.width,
  }));
  const unique = [
    ...new Map(candidates.map((d) => [d.width, d])).values(),
  ].sort((a, b) => a.width - b.width);
  return {
    original: displayUrl(value.originalUrl),
    thumbnail: client.imageUrl(value, "thumbnail"),
    card: client.imageUrl(value, "card"),
    detail: client.imageUrl(value, "detail"),
    srcSet: unique.length
      ? unique.map((d) => `${d.url} ${d.width}w`).join(", ")
      : undefined,
    width: value.width,
    height: value.height,
    alt: value.alt,
    credit: value.credit
      ? { ...value.credit, url: displayUrl(value.credit.url) }
      : undefined,
  };
}
function card(
  value: PublicCard,
  client: ReturnType<typeof catalog>,
): StoreCard {
  const { collection, images, material, ...rest } = value;
  return {
    ...rest,
    category: categoryKey(collection),
    material: ["wood", "fabric", "metal", "glass"].includes(material)
      ? (material as StoreCard["material"])
      : null,
    images: images.map((i) => image(i, client)),
  };
}
export async function readCategoryCatalog(
  signal?: AbortSignal,
): Promise<CategoryCatalog> {
  try {
    if (directEnabled()) {
      const legacy = await import("./commerce.direct.server");
      const result = await legacy.readCategoryCatalog();
      return {
        ...result,
        loadedAt: result.status === "ready" ? Date.now() : undefined,
      };
    }
    const client = catalog(),
      boot = await client.bootstrap(
        { limit: 50 },
        signal ?? getRequest().signal,
      );
    if (
      boot.data.shop.businessId !== env.STOREFRONT_BUSINESS_ID ||
      boot.data.shop.origin !== env.STOREFRONT_ORIGIN
    )
      throw new CatalogError(
        "SCOPE_MISMATCH",
        502,
        "Storefront scope mismatch",
      );
    const categories = [...boot.data.page];
    let cursor = boot.data.cursor;
    const seen = new Set<string>();
    // Navigation must be complete. Bounded at 1,000 collections; never fetch products here.
    for (let page = 1; cursor && page < 20; page++) {
      if (seen.has(cursor)) throw new Error("Invalid collection cursor");
      seen.add(cursor);
      const next = await client.collections(
        { limit: 50, cursor },
        signal ?? getRequest().signal,
      );
      categories.push(...next.data.page);
      cursor = next.data.cursor;
    }
    if (cursor) throw new Error("Collection page limit reached");
    return {
      status: "ready",
      loadedAt: boot.diagnostics.loadedAt,
      categories: categories
        .map((c) => {
          const media = c.image ? image(c.image, client) : undefined;
          return {
            id: categoryKey(c.name),
            name: c.name,
            description: c.description,
            imageUrl: media?.card ?? "",
            imageAlt: media?.alt ?? "",
            image: media,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: "unavailable", categories: [], ...failure(error) };
  }
}
export async function readProductCatalog(
  filters: ProductFilters = {},
  signal?: AbortSignal,
): Promise<ProductCatalog> {
  try {
    if (directEnabled()) {
      const { readDirectPage } = await import("./commerce-rollback.server");
      return await readDirectPage(filters);
    }
    const client = catalog();
    const result = await client.products(
      {
        limit: filters.limit ?? 24,
        ...(filters.cursor ? { cursor: filters.cursor } : {}),
        ...(filters.category
          ? { collection: backendCollection(filters.category) }
          : {}),
        ...(filters.material ? { material: filters.material } : {}),
        ...(filters.q
          ? { search: filters.q, sort: "relevance" as const }
          : { sort: "name-asc" as const }),
      },
      signal ?? getRequest().signal,
    );
    return {
      productStatus: "ready",
      loadedAt: result.diagnostics.loadedAt,
      products: result.data.page.map((p) => card(p, client)),
      cursor: result.data.cursor,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      productStatus: "unavailable",
      products: [],
      cursor: null,
      ...failure(error),
    };
  }
}
export async function readProduct(
  slug: string,
  signal?: AbortSignal,
): Promise<ProductDetail> {
  try {
    if (directEnabled()) {
      const { readDirectDetail } = await import("./commerce-rollback.server");
      return await readDirectDetail(slug);
    }
    const client = catalog(),
      result = await client.detail(slug, signal ?? getRequest().signal),
      p = result.data.product;
    return {
      status: "ready",
      loadedAt: result.diagnostics.loadedAt,
      related: p.related.slice(0, 4).map((p) => card(p, client)),
      product: {
        ...card(p, client),
        images: p.gallery.map((i) => image(i, client)),
        description: p.description,
        headline: p.page?.headline ?? "",
        specifications: p.specifications,
        faqs: p.page?.faqs ?? [],
        defaultVariant: p.defaultVariant,
        variants: p.variants.filter((v) => !v.recurring),
      },
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof CatalogError && error.code === "NOT_FOUND")
      return {
        status: "ready",
        product: null,
        related: [],
        loadedAt: Date.now(),
      };
    return {
      status: "unavailable",
      product: null,
      related: [],
      ...failure(error),
    };
  }
}
