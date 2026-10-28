import { Link } from "@tanstack/react-router";
import { ArrowRight, PenTool, Zap, Paintbrush, Truck } from "lucide-react";
import { SiteShell } from "./site-shell";
import { PieceCard } from "./piece-card";
import { buttonVariants } from "./boldkit/button";
import { Sticker, Stamp } from "./boldkit/sticker";
import {
  FAQAccordion,
  FeatureSteps,
  SectionHeading,
  StatsCards,
} from "./boldkit/blocks";
import { CategoryDirectory } from "./category-directory";
import { Route } from "@/routes/index";
import { m } from "@/paraglide/messages";
import { useCategories } from "@/lib/commerce";

const heroImage = "/images/hero-oak-canopy.webp";

export function HomePage() {
  const { categories, status } = useCategories();
  const { products, productStatus } = Route.useLoaderData();
  return (
    <SiteShell>
      {/* BoldKit HeroSplit, set on hazard yellow with a stripe edge. */}
      <section className="hero" aria-labelledby="hero-heading">
        <div className="hero-inner">
          <div className="hero-copy">
            <Sticker tape rotation="slight" variant="outline" className="mb-8">
              {m.hero_sticker()}
            </Sticker>
            <h1 id="hero-heading">{m.hero_title()}</h1>
            <p className="hero-body">{m.hero_body()}</p>
            <div className="mt-9 flex flex-wrap gap-4">
              <Link
                to="/collection"
                search={{}}
                className={buttonVariants({ variant: "ink", size: "xl" })}
              >
                {m.view_collection()}
                <ArrowRight />
              </Link>
              <a
                href="#process"
                className={buttonVariants({ variant: "outline", size: "xl" })}
              >
                {m.hero_secondary()}
              </a>
            </div>
          </div>
          <figure className="hero-plate">
            <div aria-hidden="true" className="hero-deco hero-deco-a" />
            <div aria-hidden="true" className="hero-deco hero-deco-b" />
            <div className="hero-sheet">
              <img
                src={heroImage}
                width={1254}
                height={1254}
                alt={m.hero_alt()}
                fetchPriority="high"
                decoding="async"
              />
              {/* The laser traces the plate once, leaving its kerf behind. */}
              <svg
                className="cut-path"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <rect x="0" y="0" width="100" height="100" pathLength="1" />
              </svg>
              <span className="laser-head" aria-hidden="true" />
            </div>
            <Stamp className="hero-stamp" aria-hidden="true">
              {m.hero_stamp()}
            </Stamp>
            <figcaption>
              <Link
                to="/pieces/$slug"
                params={{ slug: "oak-canopy" }}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                {m.hero_caption()}
                <ArrowRight />
              </Link>
            </figcaption>
          </figure>
        </div>
      </section>

      <StatsCards
        title={m.stats_heading()}
        stats={[
          { value: "12 mm", label: m.stat_steel() },
          { value: "4 mm", label: m.stat_aluminium() },
          { value: "1500 × 3000", label: m.stat_sheet() },
          {
            value: categories.length ? String(categories.length) : "—",
            label: m.stat_collections(),
          },
        ]}
      />

      {status !== "ready" && (
        <p role="status" className="px-4 pt-10 text-center md:px-8">
          {m.categories_unavailable()}
        </p>
      )}
      <section
        id="collections"
        className="home-category-directory page-container"
        aria-labelledby="collections-heading"
      >
        <SectionHeading
          id="collections-heading"
          title={m.category_heading()}
          description={m.category_body()}
        />
        <CategoryDirectory collections={categories} showHeading={false} />
      </section>

      <section
        className="border-y-3 border-foreground bg-secondary px-4 py-20 md:px-8 lg:px-16"
        aria-labelledby="latest-heading"
      >
        <div className="mx-auto max-w-7xl">
          <SectionHeading
            id="latest-heading"
            title={m.edit_heading()}
            description={m.edit_body()}
            action={
              <Link
                to="/collection"
                search={{}}
                className={buttonVariants({ variant: "outline" })}
              >
                {m.view_all()}
                <ArrowRight />
              </Link>
            }
          />
          <div className="piece-grid">
            {products.slice(0, 4).map((piece) => (
              <PieceCard key={piece.slug} piece={piece} />
            ))}
          </div>
          {productStatus !== "ready" && (
            <p role="status">{m.products_unavailable()}</p>
          )}
          {productStatus === "ready" && !products.length && (
            <p>{m.no_pieces()}</p>
          )}
        </div>
      </section>

      <FeatureSteps
        id="process"
        title={m.process_heading()}
        stepLabel={(number) => m.step({ number: String(number) })}
        steps={[
          {
            title: m.process_1_title(),
            description: m.process_1_body(),
            icon: <PenTool />,
          },
          {
            title: m.process_2_title(),
            description: m.process_2_body(),
            icon: <Zap />,
          },
          {
            title: m.process_3_title(),
            description: m.process_3_body(),
            icon: <Paintbrush />,
          },
          {
            title: m.process_4_title(),
            description: m.process_4_body(),
            icon: <Truck />,
          },
        ]}
      />

      <FAQAccordion
        title={m.faq_heading()}
        items={[
          { question: m.faq_1_q(), answer: m.faq_1_a() },
          { question: m.faq_2_q(), answer: m.faq_2_a() },
          { question: m.faq_3_q(), answer: m.faq_3_a() },
          { question: m.faq_4_q(), answer: m.faq_4_a() },
        ]}
      />
    </SiteShell>
  );
}
