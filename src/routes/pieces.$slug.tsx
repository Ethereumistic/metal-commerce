import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ArrowLeft, ArrowUpRight, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCart } from "@/lib/cart-store";
import { SiteShell } from "@/components/site-shell";
import { PieceCard } from "@/components/piece-card";
import { ProductGallery } from "@/components/product-gallery";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { categoryLabel } from "@/lib/catalog";
import {
  getStoreProduct,
  type StoreProduct,
  type StoreCard,
  type ProductDetail as ProductDetailResult,
} from "@/lib/commerce";
import {
  recordReceipt,
  receiptExpired,
  catalogKey,
} from "@/lib/catalog-freshness";
import { defaultOption, priceLabel } from "@/lib/product-copy";
import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/pieces/$slug")({
  loader: async ({ params, context, abortController, parentMatchPromise }) => {
    if (!/^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/.test(params.slug))
      throw notFound();
    const parent = await parentMatchPromise;
    const result: ProductDetailResult =
      parent.loaderData?.errorCode === "SCOPE_MISMATCH"
        ? {
            status: "unavailable",
            product: null,
            related: [],
            errorCode: "SCOPE_MISMATCH",
          }
        : await getStoreProduct({
            data: params.slug,
            signal: abortController.signal,
          });
    if (result.status === "ready" && !result.product) throw notFound();
    recordReceipt(
      context,
      catalogKey("/pieces/$slug", undefined, params.slug),
      result,
    );
    return result;
  },
  shouldReload: ({ context, params }) =>
    receiptExpired(
      context,
      catalogKey("/pieces/$slug", undefined, params.slug),
    ),
  staleTime: 30_000,
  preloadStaleTime: 30_000,
  head: ({ loaderData }) => ({
    meta: [
      { title: (loaderData?.product?.name ?? m.collection()) + " — MORIS" },
      {
        name: "description",
        content: loaderData?.product?.description ?? m.collection_intro(),
      },
    ],
  }),
  component: PiecePage,
});

function PiecePage() {
  const { product, related } = Route.useLoaderData();
  return product ? (
    <ProductDetail key={product.id} piece={product} related={related} />
  ) : (
    <SiteShell>
      <div className="page-container catalog-unavailable">
        <h1>{m.collection()}</h1>
        <p role="status">{m.products_unavailable()}</p>
        <Link to="/collection" className="text-link">
          {m.back_collection()}
          <ArrowLeft size={17} />
        </Link>
      </div>
    </SiteShell>
  );
}

function ProductDetail({
  piece,
  related,
}: {
  piece: StoreProduct;
  related: StoreCard[];
}) {
  const [selected, setSelected] = useState(defaultOption(piece)?.key);
  const option =
    piece.variants.find((item) => item.key === selected) ??
    defaultOption(piece);
  return (
    <SiteShell>
      <div className="page-container">
        <nav className="breadcrumb" aria-label={m.home()}>
          <Link to="/">{m.home()}</Link>
          <span>/</span>
          <Link to="/collection" search={{ category: piece.category }}>
            {categoryLabel(piece.category)}
          </Link>
          <span>/</span>
          <span>{piece.name}</span>
        </nav>
        <section className="product-layout">
          <ProductGallery images={piece.images} name={piece.name} />
          <div className="product-info">
            <p className="small-label">{categoryLabel(piece.category)}</p>
            <h1>{piece.name}</h1>
            {piece.headline && (
              <p className="product-headline">{piece.headline}</p>
            )}
            {option && (
              <div className="product-commercial">
                <p className="product-price" aria-live="polite">
                  {priceLabel(option.amount, piece.currency)}
                </p>
                {option.mode === "made_to_order" && (
                  <p className="production-note">
                    {option.leadMaxDays > 0
                      ? m.production_window({
                          min: option.leadMinDays,
                          max: option.leadMaxDays,
                        })
                      : m.made_to_order()}
                  </p>
                )}
              </div>
            )}
            {piece.variants.length > 1 && (
              <fieldset className="finish-options">
                <legend>{m.product_finish_choice()}</legend>
                <div>
                  {piece.variants.map((item) => (
                    <label key={item.key}>
                      <input
                        type="radio"
                        name={`finish-${piece.id}`}
                        value={item.key}
                        checked={item.key === option?.key}
                        onChange={() => setSelected(item.key)}
                      />
                      <span>{item.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {option && <AddToBag piece={piece} option={option} />}
            <p className="product-description">{piece.description}</p>
            <Accordion defaultValue={["details"]} className="product-accordion">
              {piece.specifications.length > 0 && (
                <AccordionItem value="details">
                  <AccordionTrigger>{m.details()}</AccordionTrigger>
                  <AccordionContent>
                    <dl>
                      {piece.specifications.map((item, i) => (
                        <div key={i}>
                          <dt>{item.label}</dt>
                          <dd>{item.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </AccordionContent>
                </AccordionItem>
              )}
              {piece.material === "wood" && (
                <AccordionItem value="care">
                  <AccordionTrigger>{m.care()}</AccordionTrigger>
                  <AccordionContent>
                    <p>{m.care_body()}</p>
                  </AccordionContent>
                </AccordionItem>
              )}
              {piece.faqs.map((faq, i) => (
                <AccordionItem key={i} value={`faq-${i}`}>
                  <AccordionTrigger>{faq.question}</AccordionTrigger>
                  <AccordionContent>
                    <p>{faq.answer}</p>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
            <Link
              to="/collection"
              search={{ category: piece.category }}
              className="text-link product-collection-link"
            >
              {m.view_category({ category: categoryLabel(piece.category) })}
              <ArrowUpRight size={19} />
            </Link>
          </div>
        </section>
        <Link
          to="/collection"
          search={{ category: piece.category }}
          className="text-link back-link"
        >
          <ArrowLeft size={17} />
          {m.back_collection()}
        </Link>
        {related.length > 0 && (
          <section className="related-section">
            <div className="section-heading">
              <div>
                <h2>{m.related()}</h2>
                <p>{m.related_body()}</p>
              </div>
            </div>
            <div className="piece-grid">
              {related.map((item) => (
                <PieceCard key={item.id} piece={item} />
              ))}
            </div>
          </section>
        )}
      </div>
    </SiteShell>
  );
}

function AddToBag({
  piece,
  option,
}: {
  piece: StoreProduct;
  option: StoreProduct["variants"][number];
}) {
  const add = useCart((state) => state.add);
  const setOpen = useCart((state) => state.setOpen);
  const [added, setAdded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => setAdded(false), [option.key]);
  return (
    <div className="add-to-bag">
      <button
        type="button"
        className="moris-button"
        data-added={added ? "true" : undefined}
        onClick={(event) => {
          const photo = event.currentTarget
            .closest(".product-layout")
            ?.querySelector<HTMLElement>(".gallery-stage img");
          const rect = (photo ?? event.currentTarget).getBoundingClientRect();
          add(
            {
              productId: piece.id,
              variantKey: option.key,
              quantity: 1,
              answers: [],
              name: piece.name,
              slug: piece.slug,
              variantLabel: option.label,
              unitAmount: option.amount,
              currency: piece.currency,
              image: piece.images[0]?.thumbnail,
              madeToOrder: option.mode === "made_to_order",
              leadMinDays: option.leadMinDays,
              leadMaxDays: option.leadMaxDays,
            },
            { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          );
          setAdded(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setAdded(false), 2400);
        }}
      >
        {added ? (
          <>
            <Check size={17} aria-hidden="true" />
            {m.added_to_bag()}
          </>
        ) : (
          m.add_to_bag()
        )}
      </button>
      <button
        type="button"
        className="text-link add-to-bag-view"
        data-visible={added ? "true" : undefined}
        onClick={() => setOpen(true)}
      >
        {m.view_bag()}
        <ArrowUpRight size={17} />
      </button>
    </div>
  );
}
