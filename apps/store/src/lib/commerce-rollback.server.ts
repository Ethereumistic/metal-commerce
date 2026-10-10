// Explicit rollback only. The legacy contract has no global discovery projection,
// so this bounded compatibility path costs more origin reads than the gateway.
import { Buffer } from "node:buffer";
import { env } from "cloudflare:workers";
import * as legacy from "./commerce.direct.server";
import type {
  ProductCatalog,
  ProductDetail,
  ProductFilters,
  StoreCard,
  StoreProduct,
} from "./commerce";

function product(p: legacy.StoreProduct): StoreProduct {
  const amounts = p.variants.map((v) => v.amount);
  return {
    ...p,
    minAmount: amounts.length ? Math.min(...amounts) : 0,
    maxAmount: amounts.length ? Math.max(...amounts) : 0,
    optionLabel:
      (p.variants.find((v) => v.key === p.defaultVariant) ?? p.variants[0])
        ?.label ?? "",
    images: p.images.map((original) => ({
      original,
      thumbnail: original,
      card: original,
      detail: original,
      alt: p.name,
    })),
    variants: p.variants.map((v) => ({ ...v, methods: [] })),
  };
}
function card(p: legacy.StoreProduct): StoreCard {
  const {
    description,
    headline,
    specifications,
    faqs,
    variants,
    defaultVariant,
    ...result
  } = product(p);
  return { ...result, images: result.images.slice(0, 2) };
}
export async function readDirectPage(
  filters: ProductFilters,
): Promise<ProductCatalog> {
  const result = await legacy.readProductCatalog();
  if (result.productStatus !== "ready")
    return { ...result, products: [], cursor: null };
  const limit = filters.limit ?? 24;
  const scope = JSON.stringify({
    adapter: "direct-v1",
    businessId: env.STOREFRONT_BUSINESS_ID,
    category: filters.category ?? "",
    material: filters.material ?? "",
    q: filters.q ?? "",
    sort: filters.sort ?? "",
    limit,
  });
  let offset = 0;
  if (filters.cursor) {
    try {
      const cursor = JSON.parse(
        Buffer.from(filters.cursor, "base64url").toString("utf8"),
      );
      if (
        cursor.scope !== scope ||
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0 ||
        cursor.offset > 1000
      )
        throw new Error();
      offset = cursor.offset;
    } catch {
      return {
        productStatus: "unavailable",
        products: [],
        cursor: null,
        errorCode: "RESTART_PAGINATION",
      };
    }
  }
  const term = filters.q?.normalize("NFKC").toLowerCase();
  const all = result.products.filter(
    (p) =>
      (!filters.category || p.category === filters.category) &&
      (!filters.material || p.material === filters.material) &&
      (!term ||
        `${p.name} ${p.description} ${p.category} ${p.specifications.map((s) => s.value).join(" ")}`
          .normalize("NFKC")
          .toLowerCase()
          .includes(term)),
  );
  all.sort((a, b) => {
    const an = a.name.normalize("NFKC").toLowerCase(),
      bn = b.name.normalize("NFKC").toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : a.slug.localeCompare(b.slug);
  });
  return {
    productStatus: "ready",
    loadedAt: Date.now(),
    products: all.slice(offset, offset + limit).map(card),
    cursor:
      offset + limit < all.length
        ? Buffer.from(
            JSON.stringify({ scope, offset: offset + limit }),
            "utf8",
          ).toString("base64url")
        : null,
  };
}
export async function readDirectDetail(slug: string): Promise<ProductDetail> {
  const result = await legacy.readProduct(slug);
  const catalog = result.product ? await legacy.readProductCatalog() : null;
  const related =
    catalog?.productStatus === "ready" && result.product
      ? catalog.products
          .filter((p) => p.id !== result.product!.id)
          .sort(
            (a, b) =>
              Number(b.category === result.product!.category) -
              Number(a.category === result.product!.category),
          )
          .slice(0, 4)
          .map(card)
      : [];
  return {
    ...result,
    product: result.product ? product(result.product) : null,
    related,
    loadedAt: result.status === "ready" ? Date.now() : undefined,
  };
}
