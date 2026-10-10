import { env } from "cloudflare:workers";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type {
  CategoryCatalog,
  StoreCategory,
  StoreVariant as PublicVariant,
} from "./commerce";
export type StoreVariant = Omit<PublicVariant, "methods">;
export interface StoreProduct {
  id: string;
  slug: string;
  name: string;
  category: string;
  description: string;
  headline: string;
  images: string[];
  material: "wood" | "fabric" | "metal" | "glass" | null;
  specifications: { label: string; value: string }[];
  faqs: { question: string; answer: string }[];
  variants: StoreVariant[];
  defaultVariant: string;
  currency: "EUR" | "USD" | "GBP" | "BGN";
}
interface ProductCatalog {
  productStatus: "ready" | "pending" | "unavailable";
  products: StoreProduct[];
}

const contractQuery = makeFunctionReference<
  "query",
  Record<string, never>,
  unknown
>("contract:get");
const resolveQuery = makeFunctionReference<
  "query",
  { origin: string },
  unknown
>("commerce/catalog:resolveStorefront");
const collectionsQuery = makeFunctionReference<
  "query",
  { businessId: string; limit: number; cursor?: string },
  unknown
>("commerce/catalog:collectionCards");
const productsQuery = makeFunctionReference<
  "query",
  { businessId: string; limit: number; cursor?: string },
  unknown
>("commerce/catalog:listProducts");
const productQuery = makeFunctionReference<
  "query",
  { businessId: string; slug: string },
  unknown
>("commerce/catalog:getProduct");

function client() {
  return new ConvexHttpClient(env.STOREFRONT_CONVEX_URL, {
    skipConvexDeploymentUrlCheck: true,
    logger: false,
    fetch: (input, init) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(8000) }),
  });
}

async function resolveShop(connection: ConvexHttpClient) {
  const contract = await connection.query(contractQuery, {});
  if (
    !record(contract) ||
    contract.protocol !== 1 ||
    !record(contract.capabilities) ||
    !Array.isArray(contract.capabilities.commerceCatalog) ||
    !contract.capabilities.commerceCatalog.includes(1)
  ) {
    throw new Error("Unsupported commerce contract");
  }
  const shop = await connection.query(resolveQuery, {
    origin: env.STOREFRONT_ORIGIN,
  });
  if (shop === null) return null;
  if (
    !record(shop) ||
    shop.origin !== env.STOREFRONT_ORIGIN ||
    shop.businessId !== env.STOREFRONT_BUSINESS_ID ||
    !record(shop.settings) ||
    typeof shop.settings.currency !== "string" ||
    !["EUR", "USD", "GBP", "BGN"].includes(shop.settings.currency)
  ) {
    throw new Error("Storefront scope mismatch");
  }
  return { currency: shop.settings.currency as StoreProduct["currency"] };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function imageUrl(value: string) {
  if (!value) return "";
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Invalid category image");
  return url.href;
}

function categoryKey(name: string) {
  return [
    "tables",
    "chairs",
    "desks",
    "lamps",
    "sideboards",
    "mirrors",
    "benches",
  ].includes(name.toLowerCase())
    ? name.toLowerCase()
    : name;
}

function category(value: unknown): StoreCategory {
  if (
    !record(value) ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    typeof value.imageUrl !== "string" ||
    typeof value.imageAlt !== "string" ||
    value.published !== true
  ) {
    throw new Error("Invalid category response");
  }
  // Preserve existing category URLs; new names use their exact collection name.
  const known = [
    "tables",
    "chairs",
    "desks",
    "lamps",
    "sideboards",
    "mirrors",
    "benches",
  ];
  const lower = value.name.toLowerCase();
  return {
    id: known.includes(lower) ? lower : value.name,
    name: value.name,
    description: value.description,
    imageUrl: imageUrl(value.imageUrl),
    imageAlt: value.imageAlt,
  };
}

export async function readCategoryCatalog(): Promise<CategoryCatalog> {
  try {
    const connection = client();
    const shop = await resolveShop(connection);
    if (shop === null) return { status: "pending", categories: [] };
    const categories: StoreCategory[] = [];
    let cursor: string | undefined;
    // Fetch every category page with bounded work. Never silently publish a partial menu.
    for (let page = 0; page < 20; page++) {
      const result = await connection.query(collectionsQuery, {
        businessId: env.STOREFRONT_BUSINESS_ID,
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      if (
        !record(result) ||
        !Array.isArray(result.page) ||
        result.page.length > 50 ||
        (result.cursor !== null && typeof result.cursor !== "string")
      )
        throw new Error("Invalid category page");
      categories.push(...result.page.map(category));
      if (result.cursor === null) {
        const order = [
          "tables",
          "chairs",
          "desks",
          "lamps",
          "sideboards",
          "mirrors",
          "benches",
        ];
        categories.sort((a, b) => {
          const ai = order.indexOf(a.id),
            bi = order.indexOf(b.id);
          return (
            (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi) ||
            a.name.localeCompare(b.name)
          );
        });
        return { status: "ready", categories };
      }
      if (!result.cursor || result.cursor === cursor)
        throw new Error("Invalid pagination cursor");
      cursor = result.cursor;
    }
    throw new Error("Category pagination limit reached");
  } catch {
    // Keep internal backend errors and all server configuration out of the browser.
    console.warn("Metal Craft category catalog unavailable");
    return { status: "unavailable", categories: [] };
  }
}

function pairs(
  value: unknown,
  first: string,
  second: string,
): { first: string; second: string }[] {
  if (!Array.isArray(value) || value.length > 50)
    throw new Error("Invalid product text");
  return value.map((item) => {
    if (
      !record(item) ||
      typeof item[first] !== "string" ||
      typeof item[second] !== "string"
    )
      throw new Error("Invalid product text");
    return { first: item[first], second: item[second] };
  });
}

function variant(value: unknown): StoreVariant | null {
  if (
    !record(value) ||
    typeof value.key !== "string" ||
    typeof value.label !== "string" ||
    typeof value.amount !== "number" ||
    !Number.isSafeInteger(value.amount) ||
    value.amount < 0 ||
    (value.mode !== "stock" && value.mode !== "made_to_order") ||
    typeof value.leadMinDays !== "number" ||
    typeof value.leadMaxDays !== "number" ||
    !Number.isSafeInteger(value.leadMinDays) ||
    !Number.isSafeInteger(value.leadMaxDays) ||
    value.leadMinDays < 0 ||
    value.leadMaxDays < value.leadMinDays ||
    typeof value.active !== "boolean"
  ) {
    throw new Error("Invalid product option");
  }
  // The current catalog is a one-time furniture collection. Never misrepresent
  // a recurring price as a one-time amount.
  if (!value.active || value.recurring) return null;
  return {
    key: value.key,
    label: value.label,
    amount: value.amount,
    mode: value.mode,
    leadMinDays: value.leadMinDays,
    leadMaxDays: value.leadMaxDays,
  };
}

function product(
  value: unknown,
  currency: StoreProduct["currency"],
): StoreProduct {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    typeof value.slug !== "string" ||
    typeof value.name !== "string" ||
    typeof value.collection !== "string" ||
    typeof value.description !== "string" ||
    typeof value.defaultVariant !== "string" ||
    value.published !== true ||
    value.archived !== false ||
    !Array.isArray(value.imageUrls) ||
    value.imageUrls.length > 10 ||
    !value.imageUrls.every((url) => typeof url === "string") ||
    !Array.isArray(value.variants) ||
    value.variants.length > 40
  )
    throw new Error("Invalid product response");
  const specifications = pairs(value.specifications, "label", "value").map(
    (p) => ({ label: p.first, value: p.second }),
  );
  const page = value.page;
  if (
    page !== undefined &&
    (!record(page) || typeof page.headline !== "string")
  )
    throw new Error("Invalid product page");
  const faqs = record(page)
    ? pairs(page.faqs, "question", "answer").map((p) => ({
        question: p.first,
        answer: p.second,
      }))
    : [];
  const materialText =
    specifications
      .find((spec) => /^(material|materials)$/i.test(spec.label))
      ?.value.toLowerCase() ?? "";
  const material = /oak|wood|walnut|timber|ash/.test(materialText)
    ? "wood"
    : /fabric|linen|upholster/.test(materialText)
      ? "fabric"
      : /metal|steel|brass/.test(materialText)
        ? "metal"
        : /glass|mirror/.test(materialText)
          ? "glass"
          : null;
  return {
    id: value.id,
    slug: value.slug,
    name: value.name,
    category: categoryKey(value.collection),
    description: value.description,
    headline: record(page) ? (page.headline as string) : "",
    images: value.imageUrls
      .map((url) => imageUrl(url as string))
      .filter(Boolean),
    material,
    specifications,
    faqs,
    variants: value.variants
      .map(variant)
      .filter((v): v is StoreVariant => v !== null),
    defaultVariant: value.defaultVariant,
    currency,
  };
}

export async function readProductCatalog(): Promise<ProductCatalog> {
  try {
    const connection = client(),
      shop = await resolveShop(connection);
    if (!shop) return { productStatus: "pending", products: [] };
    const products: StoreProduct[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const result = await connection.query(productsQuery, {
        businessId: env.STOREFRONT_BUSINESS_ID,
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      if (
        !record(result) ||
        !Array.isArray(result.page) ||
        result.page.length > 50 ||
        (result.cursor !== null && typeof result.cursor !== "string")
      )
        throw new Error("Invalid product page");
      products.push(
        ...result.page.map((value) => product(value, shop.currency)),
      );
      if (result.cursor === null) return { productStatus: "ready", products };
      if (!result.cursor || seen.has(result.cursor))
        throw new Error("Invalid product pagination");
      seen.add(result.cursor);
      cursor = result.cursor;
    }
    throw new Error("Product pagination limit reached");
  } catch {
    console.warn("Metal Craft product catalog unavailable");
    return { productStatus: "unavailable", products: [] };
  }
}

export async function readProduct(
  slug: string,
): Promise<{
  status: "ready" | "pending" | "unavailable";
  product: StoreProduct | null;
}> {
  try {
    const connection = client(),
      shop = await resolveShop(connection);
    if (!shop) return { status: "pending", product: null };
    const result = await connection.query(productQuery, {
      businessId: env.STOREFRONT_BUSINESS_ID,
      slug,
    });
    return {
      status: "ready",
      product: result === null ? null : product(result, shop.currency),
    };
  } catch {
    console.warn("Metal Craft product unavailable");
    return { status: "unavailable", product: null };
  }
}
