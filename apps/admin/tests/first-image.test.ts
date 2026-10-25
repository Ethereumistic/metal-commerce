import { test } from "node:test";
import assert from "node:assert/strict";
import {
  galleryEntries,
  resolveFirstImage,
  toCard,
  type CatalogProduct,
} from "../src/lib/production-catalog.server.ts";

const STORAGE = "https://convex.echoray.io/api/storage";
const CDN = "https://cdn.echoray.io";

function product(overrides: Partial<CatalogProduct> = {}): CatalogProduct {
  return {
    id: "p1",
    slug: "flower",
    name: "Flower",
    revision: 3,
    published: true,
    archived: false,
    defaultVariant: "default",
    variants: [{ key: "default", label: "Default", active: true }],
    imageIds: [],
    imageUrls: [],
    ...overrides,
  };
}

function photo(id: string) {
  return {
    source: {
      id,
      url: `https://images.unsplash.com/photo-${id}`,
      alt: id,
    },
  };
}

function library(id: string, sizes: string[]) {
  const widths: Record<string, number> = {
    thumb: 256,
    card: 640,
    detail: 1200,
    full: 2048,
    master: 4000,
  };
  return {
    id,
    alt: id,
    width: 4000,
    height: 3000,
    sizes: sizes.map((size) => ({
      size,
      url: `${CDN}/${id.slice(4)}/${size}.webp`,
      width: widths[size]!,
      height: Math.round((widths[size]! * 3) / 4),
      format: "webp",
    })),
  };
}

test("image zero is used even when image one is the cleaner image", () => {
  const p = product({
    imageIds: ["kg_noisy_photo", "kg_clean_silhouette"],
    imageUrls: [`${STORAGE}/noisy`, `${STORAGE}/clean`],
  });
  const first = resolveFirstImage(p);
  assert.equal(first.ok, true);
  assert.ok(first.ok);
  assert.equal(first.source.source_identity, "kg_noisy_photo");
  assert.equal(first.source.original_url, `${STORAGE}/noisy`);
  assert.equal(first.source.gallery_index, 0);
});

test("default-variant matrix assets come before imageIds, highest rank first", () => {
  const p = product({
    defaultVariant: "black",
    variants: [
      {
        key: "black",
        label: "Black",
        active: true,
        selections: [{ dimensionId: "colour", valueId: "black" }],
      },
    ],
    matrix: {
      dimensions: [{ id: "colour", name: "Colour" }],
      assets: [
        { id: "a-low", kind: "upload", storageId: "kg_low", alt: "" },
        { id: "a-high-2", kind: "upload", storageId: "kg_high_second", alt: "" },
        { id: "a-high-1", kind: "upload", storageId: "kg_high_first", alt: "" },
      ],
      groups: [
        { id: "low", rank: 1, match: [{ dimensionId: "colour", valueId: "black" }], assetIds: ["a-low"] },
        { id: "high", rank: 5, match: [{ dimensionId: "colour", valueId: "black" }], assetIds: ["a-high-1", "a-high-2"] },
      ],
    },
    matrixImageUrls: [
      { storageId: "kg_low", url: `${STORAGE}/low` },
      { storageId: "kg_high_second", url: `${STORAGE}/high2` },
      { storageId: "kg_high_first", url: `${STORAGE}/high1` },
    ],
    imageIds: ["kg_plain"],
    imageUrls: [`${STORAGE}/plain`],
  });
  assert.deepEqual(
    galleryEntries(p).map((entry) => entry.key),
    ["kg_high_first", "kg_high_second", "kg_plain"],
  );
  const first = resolveFirstImage(p);
  assert.ok(first.ok);
  assert.equal(first.source.original_url, `${STORAGE}/high1`);
});

test("a group tied to the default variant key wins over a higher-ranked match", () => {
  const p = product({
    defaultVariant: "v1",
    variants: [
      { key: "v1", label: "V1", active: true, selections: [{ dimensionId: "d", valueId: "x" }] },
    ],
    matrix: {
      dimensions: [{ id: "d", name: "D" }],
      assets: [
        { id: "match", kind: "upload", storageId: "kg_match", alt: "" },
        { id: "exact", kind: "upload", storageId: "kg_exact", alt: "" },
      ],
      groups: [
        { id: "g1", rank: 99, match: [{ dimensionId: "d", valueId: "x" }], assetIds: ["match"] },
        { id: "g2", rank: 0, variantKey: "v1", match: [], assetIds: ["exact"] },
      ],
    },
    matrixImageUrls: [
      { storageId: "kg_match", url: `${STORAGE}/match` },
      { storageId: "kg_exact", url: `${STORAGE}/exact` },
    ],
  });
  assert.equal(galleryEntries(p)[0]?.key, "kg_exact");
});

test("matrix media is skipped when the default variant does not select every dimension", () => {
  const p = product({
    matrix: {
      dimensions: [{ id: "d", name: "D" }],
      assets: [{ id: "a", kind: "upload", storageId: "kg_matrix", alt: "" }],
      groups: [{ id: "g", rank: 1, match: [{ dimensionId: "d", valueId: "x" }], assetIds: ["a"] }],
    },
    imageIds: ["kg_plain"],
    imageUrls: [`${STORAGE}/plain`],
  });
  assert.deepEqual(galleryEntries(p).map((entry) => entry.key), ["kg_plain"]);
});

test("entries are de-duplicated in encounter order and page photos come last", () => {
  const p = product({
    defaultVariant: "v",
    variants: [{ key: "v", label: "V", active: true, selections: [{ dimensionId: "d", valueId: "x" }] }],
    matrix: {
      dimensions: [{ id: "d", name: "D" }],
      assets: [
        { id: "a", kind: "upload", storageId: "kg_shared", alt: "" },
        { id: "s", kind: "stock", photo: photo("p1") },
      ],
      groups: [{ id: "g", rank: 1, match: [{ dimensionId: "d", valueId: "x" }], assetIds: ["a", "s"] }],
    },
    matrixImageUrls: [{ storageId: "kg_shared", url: `${STORAGE}/shared` }],
    imageIds: ["kg_other", "kg_shared"],
    imageUrls: [`${STORAGE}/other`, `${STORAGE}/shared`],
    page: { photos: [photo("p1"), photo("p2")] },
  });
  assert.deepEqual(galleryEntries(p).map((entry) => entry.key), [
    "kg_shared",
    "https://images.unsplash.com/photo-p1",
    "kg_other",
    "https://images.unsplash.com/photo-p2",
  ]);
});

test("a page photo is the first image only when nothing precedes it", () => {
  const first = resolveFirstImage(product({ page: { photos: [photo("only")] } }));
  assert.ok(first.ok);
  assert.equal(first.source.original_url, "https://images.unsplash.com/photo-only");
});

test("a product without images fails with NO_FIRST_IMAGE", () => {
  const first = resolveFirstImage(product());
  assert.equal(first.ok, false);
  assert.ok(!first.ok);
  assert.equal(first.error.code, "NO_FIRST_IMAGE");
  const card = toCard(product());
  assert.equal(card.thumbnail, null);
  assert.deepEqual(card.firstImage, { ok: false, error: first.error });
});

test("an unresolvable first upload fails instead of using image two", () => {
  // core dropped the missing first file, so imageUrls[0] is image two's URL.
  const p = product({
    imageIds: ["kg_missing", "kg_clean"],
    imageUrls: [`${STORAGE}/clean`],
  });
  const first = resolveFirstImage(p);
  assert.ok(!first.ok);
  assert.equal(first.error.code, "SOURCE_UNAVAILABLE");
  assert.equal(toCard(p).thumbnail, null);
});

test("a Library first image uses its master size, not the full display size", () => {
  const p = product({
    imageIds: ["lib:file1", "kg_clean"],
    imageUrls: [`${CDN}/file1/full.webp`, `${STORAGE}/clean`],
    images: [library("lib:file1", ["thumb", "card", "full", "master"])],
  });
  const first = resolveFirstImage(p);
  assert.ok(first.ok);
  assert.equal(first.source.source_identity, "lib:file1");
  assert.equal(first.source.original_url, `${CDN}/file1/master.webp`);
  assert.equal(first.source.width, 4000);
  assert.equal(first.thumbnail, `${CDN}/file1/thumb.webp`);
});

test("a Library image without a master uses its largest stored size", () => {
  const p = product({
    imageIds: ["lib:file2"],
    imageUrls: [`${CDN}/file2/full.webp`],
    images: [library("lib:file2", ["card", "full", "detail"])],
  });
  const first = resolveFirstImage(p);
  assert.ok(first.ok);
  assert.equal(first.source.original_url, `${CDN}/file2/full.webp`);
});

test("a Library first image missing from the view fails rather than using image two", () => {
  const p = product({
    imageIds: ["lib:gone", "kg_clean"],
    imageUrls: [`${STORAGE}/clean`],
    images: [],
  });
  const first = resolveFirstImage(p);
  assert.ok(!first.ok);
  assert.equal(first.error.code, "SOURCE_UNAVAILABLE");
});
