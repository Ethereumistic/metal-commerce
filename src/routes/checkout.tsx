import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowUpRight, Check, Lock, Mail, UserRound } from "lucide-react";
import { SiteShell } from "@/components/site-shell";
import { BagLine } from "@/components/cart";
import { AuthDialog, errorText, Field } from "@/components/auth-flow";
import {
  AddressFields,
  addressComplete,
  formatAddress,
  useCountries,
} from "@/components/address-form";
import { Input } from "@/components/ui/input";
import { cartCount, cartSubtotal, useCart } from "@/lib/cart-store";
import {
  emptyAddress,
  lineKey,
  shopCall,
  ShopError,
  type Address,
  type ShopErrorCode,
  type ShopState,
} from "@/lib/shop";
import { priceLabel } from "@/lib/product-copy";
import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/checkout")({
  head: () => ({
    meta: [
      { title: m.checkout_title() + " — MORIS" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: CheckoutPage,
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function CheckoutPage() {
  const items = useCart((state) => state.items);
  const status = useCart((state) => state.status);
  const account = useCart((state) => state.account);
  const savedAddress = useCart((state) => state.address);
  const totals = useCart((state) => state.totals);
  const pending = useCart((state) => state.pending);
  const setOpen = useCart((state) => state.setOpen);
  const [guestEmail, setGuestEmail] = useState<string>();
  const [editingAddress, setEditingAddress] = useState(false);
  // A guest who already saved a destination on this bag keeps their contact email.
  useEffect(() => {
    if (!account && savedAddress?.email && guestEmail === undefined) setGuestEmail(savedAddress.email);
  }, [account, savedAddress, guestEmail]);

  const contactEmail = account?.email ?? guestEmail;
  const contactDone = !!contactEmail;
  const shippingDone = contactDone && !!savedAddress && !editingAddress;
  const currency = totals?.currency ?? items[0]?.currency ?? "EUR";
  const subtotal = cartSubtotal(items);
  // Server totals only apply once optimistic edits have settled.
  const settled = !pending && totals && totals.subtotal === subtotal;
  const loading = status === "idle" || status === "loading";

  return (
    <SiteShell>
      <div className="page-container checkout-page">
        <nav className="breadcrumb" aria-label={m.checkout_title()}>
          <Link to="/">{m.home()}</Link>
          <span>/</span>
          <span>{m.checkout_title()}</span>
        </nav>
        <ol className="checkout-steps" aria-label={m.checkout_title()}>
          <li data-state="done">{m.checkout_step_bag()}</li>
          <li data-state={shippingDone ? "done" : "current"} aria-current={shippingDone ? undefined : "step"}>
            {m.checkout_step_details()}
          </li>
          <li data-state={shippingDone ? "current" : undefined} aria-current={shippingDone ? "step" : undefined}>
            {m.checkout_step_review()}
          </li>
          <li>{m.checkout_step_payment()}</li>
        </ol>
        <h1>{m.checkout_review()}</h1>
        {!items.length ? (
          <div className="checkout-empty">
            <p role="status">{loading ? m.checkout_loading() : m.checkout_empty()}</p>
            {!loading && (
              <Link to="/collection" search={{}} className="text-link">
                {m.bag_continue()}
                <ArrowUpRight size={18} />
              </Link>
            )}
          </div>
        ) : (
          <div className="checkout-layout">
            <div className="checkout-main">
              <CheckoutSection index={1} title={m.checkout_contact()} done={contactDone}>
                <ContactStep
                  guestEmail={guestEmail}
                  onGuest={(email) => {
                    setGuestEmail(email);
                    setEditingAddress(true);
                  }}
                  onChangeGuest={() => setGuestEmail(undefined)}
                />
              </CheckoutSection>
              <CheckoutSection index={2} title={m.profile_shipping()} done={shippingDone} disabled={!contactDone}>
                {contactDone &&
                  (shippingDone ? (
                    <AddressSummary address={savedAddress!} onChange={() => setEditingAddress(true)} />
                  ) : (
                    <ShippingStep
                      key={contactEmail}
                      email={contactEmail!}
                      onSaved={() => setEditingAddress(false)}
                    />
                  ))}
              </CheckoutSection>
              <section className="checkout-section">
                <div className="checkout-section-heading">
                  <h2>
                    {m.checkout_items()} ({cartCount(items)})
                  </h2>
                  <button type="button" className="account-switch" onClick={() => setOpen(true)}>
                    {m.checkout_edit_bag()}
                  </button>
                </div>
                <ul className="bag-lines checkout-lines">
                  {items.map((item) => (
                    <BagLine key={lineKey(item)} item={item} editable={false} />
                  ))}
                </ul>
              </section>
            </div>
            <aside className="checkout-summary" aria-label={m.checkout_summary()}>
              <h2>{m.checkout_summary()}</h2>
              <dl>
                <div>
                  <dt>{m.bag_subtotal()}</dt>
                  <dd>{priceLabel(subtotal, currency)}</dd>
                </div>
                {settled && totals.discount > 0 && (
                  <div>
                    <dt>{m.checkout_discount()}</dt>
                    <dd>−{priceLabel(totals.discount, currency)}</dd>
                  </div>
                )}
                <div>
                  <dt>{m.checkout_shipping()}</dt>
                  <dd className="checkout-muted">
                    {settled && shippingDone && totals.shipping > 0
                      ? priceLabel(totals.shipping, currency)
                      : m.checkout_shipping_pending()}
                  </dd>
                </div>
                {settled && totals.tax > 0 && (
                  <div>
                    <dt>{m.checkout_tax()}</dt>
                    <dd>{priceLabel(totals.tax, currency)}</dd>
                  </div>
                )}
                <div className="checkout-total">
                  <dt>{m.checkout_total()}</dt>
                  <dd>{priceLabel(settled ? totals.total : subtotal, currency)}</dd>
                </div>
              </dl>
              {shippingDone ? (
                <div className="checkout-paused" role="status">
                  <Lock size={17} aria-hidden="true" />
                  <div>
                    <p className="checkout-paused-title">{m.checkout_paused_title()}</p>
                    <p>{m.checkout_paused_body()}</p>
                  </div>
                </div>
              ) : (
                <p className="checkout-muted checkout-hint">{m.checkout_complete_details()}</p>
              )}
              <button type="button" className="moris-button" disabled>
                {m.checkout_continue_payment()}
              </button>
              <Link to="/collection" search={{}} className="text-link">
                <ArrowLeft size={17} />
                {m.bag_continue()}
              </Link>
            </aside>
          </div>
        )}
      </div>
    </SiteShell>
  );
}

function CheckoutSection({
  index,
  title,
  done,
  disabled,
  children,
}: {
  index: number;
  title: string;
  done: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="checkout-section" data-disabled={disabled ? "true" : undefined} aria-disabled={disabled}>
      <div className="checkout-section-heading">
        <h2>
          <span className="checkout-index" data-done={done ? "true" : undefined} aria-hidden="true">
            {done ? <Check size={13} /> : index}
          </span>
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

function ContactStep({
  guestEmail,
  onGuest,
  onChangeGuest,
}: {
  guestEmail?: string;
  onGuest: (email: string) => void;
  onChangeGuest: () => void;
}) {
  const account = useCart((state) => state.account);
  const signOut = useCart((state) => state.signOut);
  const [choice, setChoice] = useState<"guest" | "account">();
  const [dialog, setDialog] = useState(false);
  const [email, setEmail] = useState(guestEmail ?? "");
  const [invalid, setInvalid] = useState(false);

  if (account)
    return (
      <div className="contact-summary">
        <UserRound size={18} aria-hidden="true" />
        <div>
          <p>{m.account_signed_in_as({ email: account.email })}</p>
          <button type="button" className="account-switch" onClick={() => void signOut()}>
            {m.checkout_sign_out_switch()}
          </button>
        </div>
      </div>
    );
  if (guestEmail)
    return (
      <div className="contact-summary">
        <Mail size={18} aria-hidden="true" />
        <div>
          <p className="small-label">{m.checkout_as_guest()}</p>
          <p>{guestEmail}</p>
        </div>
        <button type="button" className="account-switch" onClick={onChangeGuest}>
          {m.checkout_change()}
        </button>
      </div>
    );
  function submitGuest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = email.trim().toLowerCase();
    if (!EMAIL.test(value) || value.length > 254) return setInvalid(true);
    setInvalid(false);
    onGuest(value);
  }
  return (
    <div className="contact-choice">
      <p className="checkout-muted">{m.checkout_contact_question()}</p>
      <div className="choice-cards" role="radiogroup" aria-label={m.checkout_contact_question()}>
        <button
          type="button"
          role="radio"
          aria-checked={choice === "account"}
          className="choice-card"
          onClick={() => {
            setChoice("account");
            setDialog(true);
          }}
        >
          <UserRound size={20} aria-hidden="true" />
          <span className="choice-title">{m.checkout_account_title()}</span>
          <span className="choice-body">{m.checkout_account_body()}</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={choice === "guest"}
          className="choice-card"
          onClick={() => setChoice("guest")}
        >
          <Mail size={20} aria-hidden="true" />
          <span className="choice-title">{m.checkout_guest_title()}</span>
          <span className="choice-body">{m.checkout_guest_body()}</span>
        </button>
      </div>
      {choice === "guest" && (
        <form className="guest-form" onSubmit={submitGuest} noValidate>
          <Field label={m.checkout_guest_email()}>
            {(id) => (
              <Input
                id={id}
                type="email"
                autoComplete="email"
                inputMode="email"
                required
                autoFocus
                maxLength={254}
                value={email}
                aria-invalid={invalid || undefined}
                onChange={(event) => setEmail(event.target.value)}
                className="moris-input"
              />
            )}
          </Field>
          {invalid && (
            <p className="account-error" role="alert">
              {m.error_invalid_email()}
            </p>
          )}
          <button type="submit" className="moris-button">
            {m.auth_continue()}
          </button>
        </form>
      )}
      <AuthDialog
        open={dialog}
        onOpenChange={(open) => {
          setDialog(open);
          if (!open && !account) setChoice((current) => (current === "account" ? undefined : current));
        }}
      />
    </div>
  );
}

function ShippingStep({ email, onSaved }: { email: string; onSaved: () => void }) {
  const account = useCart((state) => state.account);
  const savedAddress = useCart((state) => state.address);
  const accept = useCart((state) => state.accept);
  const [address, setAddress] = useState<Address>(() => ({
    ...(savedAddress ?? account?.shipping ?? emptyAddress(email, account?.name ?? "")),
    email,
  }));
  const [remember, setRemember] = useState(!!account && !account.shipping);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ShopErrorCode>();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!addressComplete(address)) return setError("invalid_address");
    setBusy(true);
    setError(undefined);
    void shopCall<ShopState>("saveCheckout", { address: { ...address, email }, remember: !!account && remember })
      .then((state) => {
        accept(state);
        onSaved();
      })
      .catch((failure) => setError(failure instanceof ShopError ? failure.code : "unavailable"))
      .finally(() => setBusy(false));
  }
  return (
    <form className="shipping-form" onSubmit={submit} noValidate>
      <p className="checkout-muted">{m.checkout_shipping_body()}</p>
      <AddressFields idPrefix="checkout" value={address} onChange={setAddress} disabled={busy} />
      {account && (
        <label className="moris-check">
          <input type="checkbox" checked={remember} disabled={busy} onChange={(event) => setRemember(event.target.checked)} />
          <span>{m.checkout_remember()}</span>
        </label>
      )}
      {error && (
        <p className="account-error" role="alert">
          {errorText[error]()}
        </p>
      )}
      <button type="submit" className="moris-button" disabled={busy}>
        {busy ? m.account_working() : m.checkout_save_shipping()}
      </button>
    </form>
  );
}

function AddressSummary({ address, onChange }: { address: Address; onChange: () => void }) {
  const countries = useCountries();
  const name = (code: string) => countries.find((c) => c.code === code)?.name ?? code;
  return (
    <div className="contact-summary">
      <div>
        <p className="small-label">{m.checkout_ship_to()}</p>
        <address>
          {formatAddress(address, name).map((line, i) => (
            <span key={i}>{line}</span>
          ))}
        </address>
      </div>
      <button type="button" className="account-switch" onClick={onChange}>
        {m.checkout_change()}
      </button>
    </div>
  );
}
