import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Minus, Plus, ShoppingBag, User, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cartCount, cartSubtotal, useCart } from "@/lib/cart-store";
import { lineKey, MAX_LINE_QUANTITY, type CartItem } from "@/lib/shop";
import { priceLabel } from "@/lib/product-copy";
import { m } from "@/paraglide/messages";

/** Restores the saved bag for first paint, then syncs it with the shop. Re-syncs when the tab regains focus. */
export function CartSync() {
  useEffect(() => {
    void Promise.resolve(useCart.persist.rehydrate()).then(() =>
      useCart.getState().load(),
    );
    const refresh = () => {
      if (document.visibilityState === "visible") void useCart.getState().load();
    };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, []);
  return null;
}

export function AccountLink() {
  const signedIn = useCart((state) => !!state.account);
  return (
    <Link
      to="/account"
      className="header-icon"
      aria-label={m.account()}
      data-signed-in={signedIn ? "true" : undefined}
    >
      <User size={20} />
    </Link>
  );
}

export function BagButton() {
  const count = useCart((state) => cartCount(state.items));
  const bump = useCart((state) => state.bump);
  const setOpen = useCart((state) => state.setOpen);
  return (
    <Button
      variant="ghost"
      className="header-icon bag-button"
      aria-label={m.bag_open({ count })}
      data-cart-target=""
      onClick={() => setOpen(true)}
    >
      <ShoppingBag size={20} />
      {count > 0 && (
        <span key={bump} className="bag-count" aria-hidden="true">
          {count}
        </span>
      )}
    </Button>
  );
}

export function QuantityStepper({ item }: { item: CartItem }) {
  const setQuantity = useCart((state) => state.setQuantity);
  return (
    <div className="quantity-stepper" role="group" aria-label={m.bag_quantity()}>
      <button
        type="button"
        aria-label={m.bag_decrease()}
        disabled={item.quantity <= 1}
        onClick={() => setQuantity(item, item.quantity - 1)}
      >
        <Minus size={14} />
      </button>
      <output aria-live="polite">{item.quantity}</output>
      <button
        type="button"
        aria-label={m.bag_increase()}
        disabled={item.quantity >= MAX_LINE_QUANTITY}
        onClick={() => setQuantity(item, item.quantity + 1)}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

export function BagLine({
  item,
  editable = true,
  onNavigate,
}: {
  item: CartItem;
  editable?: boolean;
  onNavigate?: () => void;
}) {
  const remove = useCart((state) => state.remove);
  return (
    <li className="bag-line">
      <Link
        to="/pieces/$slug"
        params={{ slug: item.slug }}
        className="bag-line-photo"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onNavigate}
      >
        {item.image && (
          <img src={item.image} alt="" loading="lazy" decoding="async" />
        )}
      </Link>
      <div className="bag-line-body">
        <div className="bag-line-heading">
          <Link
            to="/pieces/$slug"
            params={{ slug: item.slug }}
            onClick={onNavigate}
          >
            {item.name}
          </Link>
          <span>{priceLabel(item.unitAmount * item.quantity, item.currency)}</span>
        </div>
        <p className="small-label">
          {item.variantLabel}
          {item.madeToOrder && (
            <>
              {" · "}
              {item.leadMaxDays > 0
                ? m.production_window({
                    min: item.leadMinDays,
                    max: item.leadMaxDays,
                  })
                : m.made_to_order()}
            </>
          )}
        </p>
        {editable ? (
          <div className="bag-line-actions">
            <QuantityStepper item={item} />
            <button
              type="button"
              className="bag-remove"
              aria-label={m.bag_remove_item({ name: item.name })}
              onClick={() => remove(item)}
            >
              {m.bag_remove()}
            </button>
          </div>
        ) : (
          <p className="small-label">
            {m.bag_quantity()}: {item.quantity}
          </p>
        )}
      </div>
    </li>
  );
}

export function CartDrawer() {
  const open = useCart((state) => state.open);
  const setOpen = useCart((state) => state.setOpen);
  const items = useCart((state) => state.items);
  const pending = useCart((state) => state.pending);
  const error = useCart((state) => state.error);
  const status = useCart((state) => state.status);
  const currency = items[0]?.currency ?? "EUR";
  const close = () => setOpen(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="bag-drawer" showCloseButton={false}>
        <SheetHeader className="bag-header">
          <SheetTitle>
            {m.bag_title()}
            {items.length > 0 && <span> ({cartCount(items)})</span>}
          </SheetTitle>
          <SheetDescription className="sr-only">{m.bag_delivery_note()}</SheetDescription>
          <Button
            variant="ghost"
            className="header-icon"
            aria-label={m.close()}
            onClick={close}
          >
            <X size={20} />
          </Button>
        </SheetHeader>
        <p className="sr-only" role="status" aria-live="polite">
          {pending ? m.bag_updating() : ""}
        </p>
        {error && status !== "loading" && (
          <p className="bag-error" role="alert">
            {m.bag_error()}
          </p>
        )}
        {items.length ? (
          <ul className="bag-lines" data-pending={pending ? "true" : undefined}>
            {items.map((item) => (
              <BagLine key={lineKey(item)} item={item} onNavigate={close} />
            ))}
          </ul>
        ) : (
          <div className="bag-empty">
            <p className="bag-empty-title">
              {status === "loading" ? m.checkout_loading() : m.bag_empty()}
            </p>
            {status !== "loading" && <p>{m.bag_empty_body()}</p>}
            <Link to="/collection" search={{}} className="text-link" onClick={close}>
              {m.bag_continue()}
              <ArrowUpRight size={18} />
            </Link>
          </div>
        )}
        {items.length > 0 && (
          <SheetFooter className="bag-footer">
            <div className="bag-subtotal">
              <span>{m.bag_subtotal()}</span>
              <span>{priceLabel(cartSubtotal(items), currency)}</span>
            </div>
            <p className="small-label">{m.bag_delivery_note()}</p>
            <Link
              to="/checkout"
              className="moris-button"
              aria-disabled={pending}
              onClick={(event) => {
                if (pending) event.preventDefault();
                else close();
              }}
            >
              {m.bag_checkout()}
            </Link>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** Flies the product thumbnail into the bag button; skipped for reduced motion. */
export function CartFlightLayer() {
  const flight = useCart((state) => state.flight);
  const announcement = useCart((state) => state.announcement);
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const element = ref.current;
    const target = Array.from(
      document.querySelectorAll<HTMLElement>("[data-cart-target]"),
    ).find((node) => node.getClientRects().length > 0);
    if (
      !flight ||
      !element ||
      !target ||
      !element.animate ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const size = 72;
    const end = target.getBoundingClientRect();
    const start = flight.from;
    const x = start.x + start.width / 2 - size / 2;
    const y = start.y + start.height / 2 - size / 2;
    const tx = end.x + end.width / 2 - size / 2;
    const ty = end.y + end.height / 2 - size / 2;
    element.hidden = false;
    const animation = element.animate(
      [
        { transform: `translate(${x}px, ${y}px) scale(1.6)`, opacity: 0 },
        {
          transform: `translate(${x}px, ${y}px) scale(1.25)`,
          opacity: 1,
          offset: 0.12,
        },
        {
          transform: `translate(${x + (tx - x) * 0.5}px, ${Math.min(y, ty) - 60}px) scale(0.8)`,
          opacity: 1,
          offset: 0.55,
        },
        { transform: `translate(${tx}px, ${ty}px) scale(0.18)`, opacity: 0.2 },
      ],
      { duration: 720, easing: "cubic-bezier(.3,.7,.2,1)", fill: "both" },
    );
    animation.onfinish = () => {
      element.hidden = true;
      target.animate(
        [
          { transform: "scale(1)" },
          { transform: "scale(1.18)" },
          { transform: "scale(1)" },
        ],
        { duration: 320, easing: "ease-out" },
      );
    };
    return () => animation.cancel();
  }, [flight]);
  if (!mounted) return null;
  return createPortal(
    <>
      {flight && (
        <div
          key={flight.id}
          ref={ref}
          hidden
          aria-hidden="true"
          className="cart-flight"
        >
          <img src={flight.image} alt="" />
        </div>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement ? m.bag_added({ name: announcement }) : ""}
      </p>
    </>,
    document.body,
  );
}
