import type { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import type {
  CatalogCard,
  FirstImageError,
  SourceSnapshot,
} from "../features/production/contracts";

// Metal Craft catalog for production, read from Echoray core as the signed-in
// operator (commerce/catalog:listCatalog and getCatalogProduct, which include
// drafts). Nothing here writes to Commerce.
//
// The product's first image is gallery entry zero in the storefront's
// canonical order (core: publicCatalog.ts `images`): the default variant's
// matrix assets, then `imageIds`, then page photos, de-duplicated in
// encounter order. Production always traces that entry's original/master
// file. If it cannot be resolved the product fails; it never falls back to
// the next image.

export const CATALOG_PAGE_LIMIT = 50;

type Selection = { dimensionId: string; valueId: string };
type PagePhoto = { source: { id: string; url: string; alt: string } };
type MatrixAsset =
  | { id: string; kind: "upload"; storageId: string; alt: string }
  | { id: string; kind: "stock"; photo: PagePhoto };
type LibrarySize = {
  size: string;
  url: string;
  width: number;
  height: number;
  format: string;
};
type LibraryImage = {
  id: string;
  alt: string;
  width: number;
  height: number;
  sizes: LibrarySize[];
};

/** The subset of core's `productView` that production reads. */
export type CatalogProduct = {
  id: string;
  slug: string;
  name: string;
  revision: number;
  published: boolean;
  archived: boolean;
  defaultVariant: string;
  variants: {
    key: string;
    label: string;
    active: boolean;
    selections?: Selection[];
  }[];
  matrix?: {
    dimensions: {
      id: string;
      name: string;
      unit?: string;
      retired?: boolean;
    }[];
    assets: MatrixAsset[];
    groups: {
      id: string;
      rank: number;
      variantKey?: string;
      match: Selection[];
      assetIds: string[];
    }[];
  };
  imageIds: string[];
  imageUrls: string[];
  matrixImageUrls?: { storageId: string; url: string }[];
  images?: LibraryImage[];
  page?: { photos: PagePhoto[] };
};

export type GalleryEntry =
  | { key: string; kind: "upload"; storageId: string; origin: "matrix" | "imageIds"; imageIndex: number | null }
  | { key: string; kind: "stock"; url: string };

export type FirstImage =
  | { ok: true; source: SourceSnapshot; thumbnail: string }
  | { ok: false; error: FirstImageError };

const isLibraryRef = (id: string) => id.startsWith("lib:");

/** Mirrors core's resolveMatrixMedia (packages/commerce/src/matrix.ts). */
function matrixMedia(product: CatalogProduct): MatrixAsset[] {
  const matrix = product.matrix;
  if (!matrix) return [];
  const selections =
    product.variants.find((variant) => variant.key === product.defaultVariant)
      ?.selections ?? [];
  const complete = matrix.dimensions
    .filter((dimension) => !dimension.retired)
    .every((dimension) =>
      selections.some((selection) => selection.dimensionId === dimension.id),
    );
  if (!complete) return [];
  const group = matrix.groups
    .filter((group) =>
      group.variantKey
        ? group.variantKey === product.defaultVariant
        : group.match.length > 0 &&
          group.match.every((wanted) =>
            selections.some(
              (selection) =>
                selection.dimensionId === wanted.dimensionId &&
                selection.valueId === wanted.valueId,
            ),
          ),
    )
    .sort(
      (a, b) =>
        Number(!!b.variantKey) - Number(!!a.variantKey) || b.rank - a.rank,
    )[0];
  return (
    group?.assetIds.flatMap((id) => {
      const asset = matrix.assets.find((candidate) => candidate.id === id);
      return asset ? [asset] : [];
    }) ?? []
  );
}

/** The product's gallery in canonical order, keyed like core de-duplicates it. */
export function galleryEntries(product: CatalogProduct): GalleryEntry[] {
  const candidates: GalleryEntry[] = [
    ...matrixMedia(product).map((asset): GalleryEntry =>
      asset.kind === "upload"
        ? { key: asset.storageId, kind: "upload", storageId: asset.storageId, origin: "matrix", imageIndex: null }
        : { key: asset.photo.source.url, kind: "stock", url: asset.photo.source.url },
    ),
    ...product.imageIds.map((id, index): GalleryEntry => ({
      key: id,
      kind: "upload",
      storageId: id,
      origin: "imageIds",
      imageIndex: index,
    })),
    ...(product.page?.photos ?? []).map((photo): GalleryEntry => ({
      key: photo.source.url,
      kind: "stock",
      url: photo.source.url,
    })),
  ];
  const seen = new Set<string>();
  return candidates.filter((entry) => {
    if (seen.has(entry.key)) return false;
    seen.add(entry.key);
    return true;
  });
}

function unavailable(message: string): FirstImage {
  return { ok: false, error: { code: "SOURCE_UNAVAILABLE", message } };
}

/** The best available pixels of a Library image: its `master`, else the largest stored size. */
function libraryOriginal(image: LibraryImage) {
  return (
    image.sizes.find((size) => size.size === "master") ??
    [...image.sizes].sort((a, b) => b.width * b.height - a.width * a.height)[0]
  );
}

function libraryThumbnail(image: LibraryImage) {
  return (
    image.sizes.find((size) => size.size === "thumb") ??
    image.sizes.find((size) => size.size === "card") ??
    libraryOriginal(image)
  );
}

/** URL of an uploaded (Convex storage) file in the authenticated product view. */
function storageUrl(product: CatalogProduct, entry: Extract<GalleryEntry, { kind: "upload" }>) {
  const matrixUrl = product.matrixImageUrls?.find(
    (image) => image.storageId === entry.storageId,
  )?.url;
  if (matrixUrl) return matrixUrl;
  // core drops unresolvable files from `imageUrls`, so it only lines up with
  // `imageIds` when every entry resolved. Otherwise the URL at this index could
  // belong to a later image, which must never be traced in its place.
  const index = product.imageIds.indexOf(entry.storageId);
  if (index < 0 || product.imageUrls.length !== product.imageIds.length)
    return null;
  return product.imageUrls[index] || null;
}

export function resolveFirstImage(product: CatalogProduct): FirstImage {
  const first = galleryEntries(product)[0];
  if (!first)
    return {
      ok: false,
      error: { code: "NO_FIRST_IMAGE", message: "The product has no images." },
    };

  if (first.kind === "stock") {
    return {
      ok: true,
      source: {
        gallery_index: 0,
        source_identity: first.key,
        source_version: null,
        original_url: first.url,
        width: null,
        height: null,
      },
      thumbnail: first.url,
    };
  }

  if (isLibraryRef(first.storageId)) {
    const image = product.images?.find((candidate) => candidate.id === first.storageId);
    const original = image && libraryOriginal(image);
    if (!image || !original)
      return unavailable(
        "The first image is a Library file whose original size is not available to the admin.",
      );
    return {
      ok: true,
      source: {
        gallery_index: 0,
        source_identity: first.key,
        source_version: null,
        original_url: original.url,
        width: original.width,
        height: original.height,
      },
      thumbnail: libraryThumbnail(image)!.url,
    };
  }

  const url = storageUrl(product, first);
  if (!url)
    return unavailable(
      "The first image's original file could not be resolved. Check the product's images in Echoray.",
    );
  return {
    ok: true,
    source: {
      gallery_index: 0,
      source_identity: first.key,
      source_version: null,
      original_url: url,
      width: null,
      height: null,
    },
    thumbnail: url,
  };
}

export type CatalogErrorCode =
  | "CATALOG_UNAVAILABLE"
  | "CATALOG_FORBIDDEN"
  | "CATALOG_INVALID";

export class CatalogError extends Error {
  readonly code: CatalogErrorCode;
  constructor(code: CatalogErrorCode) {
    super(code);
    this.code = code;
  }
}

function asProduct(value: unknown): CatalogProduct {
  const product = value as Partial<CatalogProduct> | null;
  if (
    !product ||
    typeof product.id !== "string" ||
    typeof product.slug !== "string" ||
    typeof product.name !== "string" ||
    typeof product.revision !== "number" ||
    !Array.isArray(product.imageIds) ||
    !Array.isArray(product.imageUrls) ||
    !Array.isArray(product.variants)
  )
    throw new CatalogError("CATALOG_INVALID");
  return product as CatalogProduct;
}

function backendCode(error: unknown) {
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "string") return data;
  return data && typeof data === "object" && "code" in data
    ? String((data as { code: unknown }).code)
    : undefined;
}

async function read<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    const code = backendCode(error);
    // core's catalog requires an editing member; viewers are refused there.
    if (code === "ACCESS_DENIED" || code === "UNAUTHENTICATED")
      throw new CatalogError("CATALOG_FORBIDDEN");
    console.warn(
      JSON.stringify({ event: "metal_admin_catalog_failed", code: code ?? null }),
    );
    throw new CatalogError("CATALOG_UNAVAILABLE");
  }
}

export function toCard(product: CatalogProduct): CatalogCard {
  const first = resolveFirstImage(product);
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    revision: product.revision,
    published: !!product.published,
    archived: !!product.archived,
    thumbnail: first.ok ? first.thumbnail : null,
    firstImage: first.ok
      ? {
          ok: true,
          sourceIdentity: first.source.source_identity,
          width: first.source.width,
          height: first.source.height,
        }
      : { ok: false, error: first.error },
    variants: product.variants.map((variant) => ({
      key: variant.key,
      label: variant.label,
      active: !!variant.active,
    })),
    dimensions: (product.matrix?.dimensions ?? [])
      .filter((dimension) => !dimension.retired)
      .map((dimension) => ({
        id: dimension.id,
        name: dimension.name,
        unit: dimension.unit ?? null,
      })),
    preparation: null,
  };
}

export async function listCatalog(
  convex: ConvexHttpClient,
  businessId: string,
  options: { cursor?: string; search?: string },
): Promise<{ products: CatalogProduct[]; cursor: string | null; scope: "all" | "search" }> {
  const search = options.search?.trim();
  const result = await read(
    () =>
      convex.query(anyApi.commerce.catalog.listCatalog, {
        businessId,
        limit: CATALOG_PAGE_LIMIT,
        ...(search ? { search } : options.cursor ? { cursor: options.cursor } : {}),
      }) as Promise<{ page: unknown[]; cursor: string | null }>,
  );
  if (!result || !Array.isArray(result.page)) throw new CatalogError("CATALOG_INVALID");
  return {
    products: result.page.map(asProduct),
    // Search on core returns the best name matches with no cursor.
    cursor: search ? null : (result.cursor ?? null),
    scope: search ? "search" : "all",
  };
}

/** Looks a product up by slug and confirms it is still the product the operator picked. */
export async function catalogProduct(
  convex: ConvexHttpClient,
  businessId: string,
  ref: { id: string; slug: string },
): Promise<CatalogProduct | null> {
  const value = await read(() =>
    convex.query(anyApi.commerce.catalog.getCatalogProduct, {
      businessId,
      slug: ref.slug,
    }),
  );
  if (!value) return null;
  const product = asProduct(value);
  return product.id === ref.id ? product : null;
}
