import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { categoryLabel } from "@/lib/catalog";
import type { StoreCard } from "@/lib/commerce";
import { priceLabel } from "@/lib/product-copy";
import { m } from "@/paraglide/messages";

export function PieceCard({ piece }: { piece: StoreCard }) {
  const [primaryFailed, setPrimaryFailed] = useState(false);
  const [secondaryReady, setSecondaryReady] = useState(false);
  const [secondaryFailed, setSecondaryFailed] = useState(false);
  const minimum = piece.minAmount;
  return (
    <Link
      to="/pieces/$slug"
      params={{ slug: piece.slug }}
      className="piece-card"
      aria-label={piece.name + " — " + categoryLabel(piece.category)}
    >
      <div
        className="piece-photo"
        data-secondary-ready={
          secondaryReady && !secondaryFailed ? "true" : undefined
        }
      >
        {piece.images[0] && !primaryFailed ? (
          <img
            src={piece.images[0].card}
            srcSet={piece.images[0].srcSet}
            sizes="(max-width: 600px) 50vw, (max-width: 1000px) 33vw, 25vw"
            width={piece.images[0].width}
            height={piece.images[0].height}
            alt={piece.name + " — " + categoryLabel(piece.category)}
            loading="lazy"
            decoding="async"
            className="piece-primary"
            onError={() => setPrimaryFailed(true)}
          />
        ) : (
          <span className="piece-image-empty">{m.image_unavailable()}</span>
        )}
        {piece.images[1] && (
          <img
            src={piece.images[1].card}
            srcSet={piece.images[1].srcSet}
            sizes="(max-width: 600px) 50vw, (max-width: 1000px) 33vw, 25vw"
            width={piece.images[1].width}
            height={piece.images[1].height}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
            className="piece-secondary"
            onLoad={() => setSecondaryReady(true)}
            onError={() => setSecondaryFailed(true)}
          />
        )}
      </div>
      <div className="piece-caption">
        <h3>{piece.name}</h3>
        {minimum !== undefined && (
          <span className="piece-price">
            {piece.maxAmount !== minimum
              ? m.price_from({ price: priceLabel(minimum, piece.currency) })
              : priceLabel(minimum, piece.currency)}
          </span>
        )}
      </div>
      <p>
        {categoryLabel(piece.category)}
        {piece.optionLabel && (
          <>
            <span aria-hidden="true"> / </span>
            {piece.optionLabel}
          </>
        )}
      </p>
    </Link>
  );
}
