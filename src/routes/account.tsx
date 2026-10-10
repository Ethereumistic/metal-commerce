import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowUpRight } from "lucide-react";
import { SiteShell } from "@/components/site-shell";
import { AuthFlow, errorText } from "@/components/auth-flow";
import { AddressFields, addressComplete } from "@/components/address-form";
import { useCart } from "@/lib/cart-store";
import {
  emptyAddress,
  shopCall,
  ShopError,
  type Address,
  type ShopAccount,
  type ShopErrorCode,
  type ShopState,
} from "@/lib/shop";
import { m } from "@/paraglide/messages";

type Next = "checkout" | undefined;

export const Route = createFileRoute("/account")({
  validateSearch: (search: Record<string, unknown>): { next?: Next } =>
    search.next === "checkout" ? { next: "checkout" } : {},
  head: () => ({
    meta: [
      { title: m.account() + " — Metal Craft" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AccountPage,
});

function AccountPage() {
  const account = useCart((state) => state.account);
  const status = useCart((state) => state.status);
  const { next } = Route.useSearch();
  const navigate = useNavigate();
  const loading = status === "idle" || (status === "loading" && !account);
  return (
    <SiteShell>
      <div className="page-container account-page" data-signed-in={account ? "true" : undefined}>
        <aside className="account-aside">
          <p className="small-label">Metal Craft</p>
          <h1>{account ? m.account_welcome() : m.account_intro()}</h1>
          <p>{account ? m.account_signed_in_as({ email: account.email }) : m.account_aside()}</p>
          {account && <AccountActions />}
        </aside>
        <section className="account-panel" aria-live="polite">
          {loading ? (
            <p className="small-label">{m.account_working()}</p>
          ) : account ? (
            <ProfileForm key={account.email} account={account} />
          ) : (
            <AuthFlow
              onSignedIn={() => {
                if (next === "checkout") void navigate({ to: "/checkout" });
              }}
            />
          )}
        </section>
      </div>
    </SiteShell>
  );
}

function AccountActions() {
  const signOut = useCart((state) => state.signOut);
  const [busy, setBusy] = useState(false);
  return (
    <div className="account-actions">
      <Link to="/checkout" className="text-link">
        {m.bag_checkout()}
        <ArrowUpRight size={18} />
      </Link>
      <button
        type="button"
        className="account-switch"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void signOut().finally(() => setBusy(false));
        }}
      >
        {m.account_sign_out()}
      </button>
    </div>
  );
}

function ProfileForm({ account }: { account: ShopAccount }) {
  const accept = useCart((state) => state.accept);
  const initialShipping = account.shipping ?? emptyAddress(account.email, account.name);
  const [shipping, setShipping] = useState<Address>(initialShipping);
  const [billing, setBilling] = useState<Address>(account.billing ?? emptyAddress(account.email));
  const [sameBilling, setSameBilling] = useState(!account.billing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ShopErrorCode>();
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [shipping, billing, sameBilling]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!addressComplete(shipping) || (!sameBilling && !addressComplete(billing))) {
      setError("invalid_address");
      return;
    }
    setBusy(true);
    setError(undefined);
    void shopCall<ShopState>("saveProfile", {
      name: shipping.name,
      shipping,
      // Billing shares the shipping phone so delivery questions reach one number.
      ...(sameBilling ? {} : { billing: { ...billing, phone: billing.phone || shipping.phone } }),
    })
      .then((state) => {
        accept(state);
        setSaved(true);
      })
      .catch((failure) => setError(failure instanceof ShopError ? failure.code : "unavailable"))
      .finally(() => setBusy(false));
  }

  return (
    <form className="account-form profile-form" onSubmit={submit} noValidate>
      <div className="auth-heading">
        <h2>{m.profile_title()}</h2>
        <p className="account-lede">{m.profile_body()}</p>
      </div>
      <fieldset className="profile-section">
        <legend>{m.profile_shipping()}</legend>
        <AddressFields idPrefix="shipping" value={shipping} onChange={setShipping} disabled={busy} />
      </fieldset>
      <fieldset className="profile-section">
        <legend>{m.profile_billing()}</legend>
        <label className="moris-check">
          <input
            type="checkbox"
            checked={sameBilling}
            disabled={busy}
            onChange={(event) => setSameBilling(event.target.checked)}
          />
          <span>{m.profile_billing_same()}</span>
        </label>
        {!sameBilling && (
          <AddressFields idPrefix="billing" value={billing} onChange={setBilling} disabled={busy} />
        )}
      </fieldset>
      {error && (
        <p className="account-error" role="alert">
          {errorText[error]()}
        </p>
      )}
      {saved && (
        <p className="account-success" role="status">
          {m.profile_saved()}
        </p>
      )}
      <button type="submit" className="moris-button" disabled={busy}>
        {busy ? m.account_working() : m.profile_save()}
      </button>
    </form>
  );
}
