import { createServerFn } from "@tanstack/react-start";
import { useLoaderData } from "@tanstack/react-router";
import type {
  PublicCard,
  CatalogResponse,
} from "@echoray/api-client/public-catalog";

// Presentation models. Wire contracts and validation are owned by the SDK.
export interface StoreImage {
  original: string;
  thumbnail: string;
  card: string;
  detail: string;
  srcSet?: string;
  width?: number;
  height?: number;
  alt: string;
  credit?: { name: string; url: string };
}
export interface StoreCategory {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  imageAlt: string;
  image?: StoreImage;
}
export interface CatalogState {
  loadedAt?: number;
  errorCode?: string;
  retryAfterSeconds?: number | null;
}
export interface CategoryCatalog extends CatalogState {
  status: "ready" | "pending" | "unavailable";
  categories: StoreCategory[];
}
export interface StoreCard extends Omit<
  PublicCard,
  "images" | "collection" | "material"
> {
  category: string;
  material: "wood" | "fabric" | "metal" | "glass" | null;
  images: StoreImage[];
}
export type StoreVariant =
  CatalogResponse<"detail">["data"]["product"]["variants"][number];
export interface StoreProduct extends StoreCard {
  description: string;
  headline: string;
  specifications: { label: string; value: string }[];
  faqs: { question: string; answer: string }[];
  variants: StoreVariant[];
  defaultVariant: string;
}
export interface ProductCatalog extends CatalogState {
  productStatus: "ready" | "pending" | "unavailable";
  products: StoreCard[];
  cursor: string | null;
}
export interface ProductDetail extends CatalogState {
  status: "ready" | "pending" | "unavailable";
  product: StoreProduct | null;
  related: StoreCard[];
}
export interface ProductFilters {
  category?: string;
  material?: StoreCard["material"];
  sort?: "name";
  q?: string;
  cursor?: string;
  limit?: number;
}

export function validateProductFilters(value: unknown): ProductFilters {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid catalog filters");
  const input = value as Record<string, unknown>;
  for (const [key, max] of [
    ["category", 200],
    ["q", 200],
    ["cursor", 8192],
  ] as const) {
    if (
      input[key] !== undefined &&
      (typeof input[key] !== "string" || input[key].length > max)
    )
      throw new Error("Invalid catalog filters");
  }
  if (input.q && (input.q as string).trim().split(/\s+/).length > 16)
    throw new Error("Refine search to at most 16 words");
  if (
    input.material !== undefined &&
    !["wood", "fabric", "metal", "glass"].includes(String(input.material))
  )
    throw new Error("Invalid material");
  if (input.sort !== undefined && input.sort !== "name")
    throw new Error("Invalid sort");
  if (
    input.limit !== undefined &&
    (!Number.isInteger(input.limit) ||
      Number(input.limit) < 1 ||
      Number(input.limit) > 50)
  )
    throw new Error("Invalid page size");
  return {
    category: input.category as string | undefined,
    material: input.material as ProductFilters["material"],
    sort: input.sort as ProductFilters["sort"],
    q: typeof input.q === "string" ? input.q.trim() || undefined : undefined,
    cursor: input.cursor as string | undefined,
    limit: input.limit as number | undefined,
  };
}

export const getStoreCatalog = createServerFn({ method: "GET" }).handler(
  async (): Promise<CategoryCatalog> => {
    const { readCategoryCatalog } = await import("./commerce.server");
    return readCategoryCatalog();
  },
);
export const getStoreProducts = createServerFn({ method: "GET" })
  .validator(validateProductFilters)
  .handler(async ({ data }): Promise<ProductCatalog> => {
    const { readProductCatalog } = await import("./commerce.server");
    return readProductCatalog(data);
  });
export const getStoreProduct = createServerFn({ method: "GET" })
  .validator((slug: unknown) => {
    if (
      typeof slug !== "string" ||
      !/^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/.test(slug)
    )
      throw new Error("Invalid product route");
    return slug;
  })
  .handler(async ({ data }): Promise<ProductDetail> => {
    const { readProduct } = await import("./commerce.server");
    return readProduct(data);
  });
export function useCategories() {
  return useLoaderData({ from: "__root__" });
}
