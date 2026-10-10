import { Link } from "@tanstack/react-router";
import { ArrowUpRight, ArrowDown } from "lucide-react";
import { SiteShell } from "./site-shell";
import { Photo } from "./photo";
import { PieceCard } from "./piece-card";
import { categoryLabel } from "@/lib/catalog";
import { Route } from "@/routes/index";
import { m } from "@/paraglide/messages";
import { useCategories } from "@/lib/commerce";

export function HomePage() {
  const { categories, status } = useCategories();
  const { products, productStatus } = Route.useLoaderData();
  return (
    <SiteShell>
      <section className="hero" aria-labelledby="hero-heading">
        <picture>
          <source
            media="(max-width: 600px)"
            srcSet="/images/hero-mobile-640.webp 640w, /images/hero-mobile-1280.webp 1280w"
            sizes="100vw"
          />
          <Photo
            name="hero"
            alt={m.hero_alt()}
            priority
            className="hero-photo"
          />
        </picture>
        <div className="hero-shade" />
        <div className="hero-content">
          <p className="hero-label">{m.new_collection()}</p>
          <h1 id="hero-heading">{m.hero_title()}</h1>
          <p className="hero-body">{m.hero_body()}</p>
          <Link
            to="/collection"
            search={{}}
            className="moris-button hero-button"
          >
            {m.view_collection()}
            <ArrowUpRight size={19} />
          </Link>
        </div>
        <a className="hero-scroll" href="#collections">
          <span>{m.hero_note()}</span>
          <ArrowDown size={19} />
        </a>
      </section>
      <section id="collections" className="section category-section">
        <div className="section-heading">
          <h2>{m.category_heading()}</h2>
          <p>{m.category_body()}</p>
        </div>
        {status !== "ready" && (
          <p role="status">{m.categories_unavailable()}</p>
        )}
        <div className="category-grid">
          {categories.map(({ id, imageUrl, imageAlt, image }) => (
            <Link
              to="/collection"
              search={{ category: id }}
              key={id}
              className={"category-card category-" + id}
            >
              <div>
                {imageUrl && (
                  <img
                    src={imageUrl}
                    srcSet={image?.srcSet}
                    sizes="(max-width: 600px) 50vw, (max-width: 1000px) 33vw, 20vw"
                    width={image?.width}
                    height={image?.height}
                    alt={imageAlt || categoryLabel(id)}
                    loading="lazy"
                    decoding="async"
                  />
                )}
              </div>
              <span>
                {categoryLabel(id)}
                <ArrowUpRight size={17} />
              </span>
            </Link>
          ))}
        </div>
      </section>
      <section className="section edit-section">
        <div className="section-heading">
          <div>
            <h2>{m.edit_heading()}</h2>
            <p>{m.edit_body()}</p>
          </div>
          <Link to="/collection" search={{}} className="text-link">
            {m.view_all()}
            <ArrowUpRight size={19} />
          </Link>
        </div>
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
      </section>
    </SiteShell>
  );
}
