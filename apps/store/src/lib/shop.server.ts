import { env } from "cloudflare:workers";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { ConvexError } from "convex/values";
import {
  applyIntent,
  lineKey,
  MAX_LINE_QUANTITY,
  PASSWORD_MAX,
  PASSWORD_MIN,
  type Address,
  type AuthLookup,
  type AuthStep,
  type CartIntent,
  type CartItem,
  type CartLine,
  type ShopErrorCode,
  type ShopState,
} from "./shop";
import { readProduct } from "./commerce.server";

// Shop gateway: the browser only ever talks to this Worker. Integration and
// customer credentials stay in HttpOnly cookies and Worker secrets.

type Credentials = {
  integrationId: string;
  secret: string;
  session?: string;
  guest: string;
};
type ServerCart = {
  id: string;
  revision: number;
  lines: CartLine[];
  [field: string]: unknown;
};
type ServerProduct = {
  id: string;
  slug: string;
  name: string;
  variants: {
    key: string;
    label: string;
    amount: number;
    mode: "stock" | "made_to_order";
    leadMinDays: number;
    leadMaxDays: number;
  }[];
};
type Quote = {
  totals: ShopState["totals"] & {};
  payable: boolean;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class GatewayError extends Error {
  constructor(readonly code: ShopErrorCode) {
    super(code);
  }
}

function config() {
  const values = env as unknown as Record<string, unknown>;
  const read = (key: string) =>
    typeof values[key] === "string" && values[key]
      ? (values[key] as string)
      : undefined;
  return {
    backend: read("STOREFRONT_CONVEX_URL"),
    integrationId: read("STOREFRONT_INTEGRATION_ID"),
    secret: read("STOREFRONT_INTEGRATION_SECRET"),
  };
}

function hex(bytes = 32) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function backendCode(error: unknown) {
  if (!(error instanceof ConvexError)) return undefined;
  const data = error.data as unknown;
  return data && typeof data === "object" && "code" in data
    ? String((data as { code: unknown }).code)
    : typeof data === "string"
      ? data
      : undefined;
}
function mapError(error: unknown, fallback: ShopErrorCode): ShopErrorCode {
  if (error instanceof GatewayError) return error.code;
  const code = backendCode(error);
  if (code === "RATE_LIMITED") return "rate_limited";
  if (code === "METHOD_DISABLED") return "method_disabled";
  if (code === "INVALID_ADDRESS") return "invalid_address";
  if (code === "SIGN_IN_REQUIRED") return "sign_in_required";
  if (code === "INVALID_CREDENTIALS") return "invalid_credentials";
  if (code === "INVALID_CODE" || code === "EXCHANGE_EXPIRED") return "invalid_code";
  if (code === "PASSWORD_RULES") return "password_rules";
  if (code === "INVALID_EMAIL") return "invalid_email";
  if (code?.includes("12–128")) return "password_rules";
  if (code?.includes("valid email")) return "invalid_email";
  const message = error instanceof Error ? error.message : "";
  if (/TooManyFailedAttempts|rate/i.test(message)) return "rate_limited";
  return fallback;
}

export function createShopGateway(request: Request) {
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  const prefix = secure ? "__Host-metal-craft-" : "metal-craft-";
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  const jar = Object.fromEntries(
    (request.headers.get("cookie") ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key]) => !!key)
      .map(([key, ...value]) => {
        try {
          return [key, decodeURIComponent(value.join("="))];
        } catch {
          return [key, ""];
        }
      }),
  ) as Record<string, string>;
  function setCookie(name: string, value: string, maxAge: number) {
    headers.append(
      "Set-Cookie",
      `${prefix}${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}${secure ? "; Secure" : ""}`,
    );
  }

  const { backend, integrationId, secret } = config();
  const client = backend ? new ConvexHttpClient(backend) : null;
  let session = jar[`${prefix}session`] || undefined;
  let guest = jar[`${prefix}guest`];
  if (!guest || !/^[a-f0-9]{64}$/.test(guest)) {
    guest = hex();
    setCookie("guest", guest, 60 * 86400);
  }
  const creds = (): Credentials => ({
    integrationId: integrationId!,
    secret: secret!,
    guest,
    ...(session ? { session } : {}),
  });

  /** A revoked or expired shopper session silently falls back to the guest bag. */
  async function scoped<T>(work: (c: Credentials) => Promise<T>): Promise<T> {
    try {
      return await work(creds());
    } catch (error) {
      if (session && backendCode(error) === "ACCESS_DENIED") {
        session = undefined;
        setCookie("session", "", 0);
        return work(creds());
      }
      throw error;
    }
  }

  async function readState(): Promise<ShopState> {
    return scoped(async (c) => {
      const cart = (await client!.query(
        anyApi.commerce.shop.getCart,
        c,
      )) as ServerCart | null;
      const lines = cart?.lines ?? [];
      const [products, account, quote] = await Promise.all([
        lines.length
          ? (client!.query(anyApi.commerce.shop.cartProducts, c) as Promise<
              ServerProduct[]
            >)
          : Promise.resolve([]),
        c.session
          ? (
              client!.query(anyApi.commerce.shop.customer, c) as Promise<{
                email?: string;
                name?: string;
                addresses?: Address[];
              }>
            ).catch(() => null)
          : Promise.resolve(null),
        lines.length
          ? (
              client!.query(anyApi.commerce.shop.quoteCheckout, c) as Promise<Quote>
            ).catch(() => null)
          : Promise.resolve(null),
      ]);
      const currency = quote?.totals.currency ?? "EUR";
      // Bag photos come from the storefront's own catalog derivatives, never backend storage URLs.
      const photos = new Map(
        await Promise.all(
          products.map(
            async (p) =>
              [
                p.id,
                await readProduct(p.slug, request.signal)
                  .then((detail) => detail.product?.images[0]?.thumbnail)
                  .catch(() => undefined),
              ] as const,
          ),
        ),
      );
      const items: CartItem[] = [];
      for (const line of lines) {
        const product = products.find((p) => p.id === line.productId);
        const variant = product?.variants.find((v) => v.key === line.variantKey);
        if (!product || !variant) continue;
        items.push({
          productId: line.productId,
          variantKey: line.variantKey,
          ...(line.offerKey ? { offerKey: line.offerKey } : {}),
          quantity: line.quantity,
          answers: line.answers,
          name: product.name,
          slug: product.slug,
          variantLabel: variant.label,
          unitAmount: variant.amount,
          currency,
          image: photos.get(product.id),
          madeToOrder: variant.mode === "made_to_order",
          leadMinDays: variant.leadMinDays,
          leadMaxDays: variant.leadMaxDays,
        });
      }
      return {
        items,
        account: c.session
          ? {
              email: account?.email ?? "",
              name: account?.name ?? "",
              ...(account?.addresses?.[0] ? { shipping: account.addresses[0] } : {}),
              ...(account?.addresses?.[1] ? { billing: account.addresses[1] } : {}),
            }
          : null,
        ...(cart?.address ? { address: cart.address as Address } : {}),
        ...(quote ? { totals: quote.totals, payable: quote.payable } : {}),
      };
    });
  }

  function validLine(raw: unknown): CartLine {
    const line = raw as Partial<CartLine> | null;
    if (
      !line ||
      typeof line.productId !== "string" ||
      typeof line.variantKey !== "string" ||
      line.productId.length > 64 ||
      line.variantKey.length > 200 ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity! < 1 ||
      line.quantity! > MAX_LINE_QUANTITY
    )
      throw new GatewayError("unavailable");
    return {
      productId: line.productId,
      variantKey: line.variantKey,
      quantity: line.quantity!,
      answers: [],
    };
  }
  function validIntent(raw: Record<string, unknown>): CartIntent {
    if (raw.kind === "add") return { kind: "add", line: validLine(raw.line) };
    if (typeof raw.key !== "string" || raw.key.length > 2000)
      throw new GatewayError("unavailable");
    if (raw.kind === "remove") return { kind: "remove", key: raw.key };
    if (
      raw.kind === "quantity" &&
      Number.isSafeInteger(raw.quantity) &&
      (raw.quantity as number) >= 1 &&
      (raw.quantity as number) <= MAX_LINE_QUANTITY
    )
      return { kind: "quantity", key: raw.key, quantity: raw.quantity as number };
    throw new GatewayError("unavailable");
  }

  /** Re-reads the cart and applies the intent at its latest revision; retries revision conflicts. */
  async function updateCart(intent: CartIntent) {
    await scoped(async (c) => {
      for (let attempt = 0; ; attempt++) {
        const cart = (await client!.query(
          anyApi.commerce.shop.getCart,
          c,
        )) as ServerCart | null;
        try {
          if (intent.kind === "remove") {
            const index =
              cart?.lines.findIndex((line) => lineKey(line) === intent.key) ??
              -1;
            if (index < 0) return;
            await client!.mutation(anyApi.commerce.shop.removeCartLine, {
              ...c,
              expectedRevision: cart!.revision,
              line: index,
            });
            return;
          }
          const { id: _id, revision, ...fields } = cart ?? {
            id: "",
            revision: 0,
            lines: [] as CartLine[],
          };
          await client!.mutation(anyApi.commerce.shop.updateCart, {
            ...c,
            expectedRevision: revision,
            cart: {
              ...fields,
              lines: applyIntent(fields.lines, intent, (line) => line),
            },
          });
          return;
        } catch (error) {
          if (attempt < 2 && backendCode(error) === "CONFLICT") continue;
          throw error;
        }
      }
    });
  }

  // Shopper sign-in uses identities that exist only in this shop (commerce/identity:*).
  // No Echoray session is ever created: each verified step authorises this Worker's PKCE
  // exchange, which it redeems for the HttpOnly shop session cookie. Between the code
  // request and the code check, the exchange and its verifier wait in an HttpOnly cookie.
  type Flow = { exchangeId: string; verifier: string; state: string };

  async function beginFlow(): Promise<Flow> {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
    const state = hex();
    const challenge = base64url(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
      ),
    );
    const exchangeId = (await client!.mutation(anyApi.commerce.auth.startExchange, {
      integrationId,
      secret,
      state,
      challenge,
      ...(await clientHash()),
    })) as string;
    setCookie("signin", JSON.stringify({ exchangeId, verifier, state }), 600);
    return { exchangeId, verifier, state };
  }
  function savedFlow(): Flow {
    try {
      const flow = JSON.parse(jar[`${prefix}signin`] || "null") as Partial<Flow> | null;
      if (
        typeof flow?.exchangeId === "string" &&
        typeof flow.verifier === "string" &&
        typeof flow.state === "string"
      )
        return flow as Flow;
    } catch {
      // Fall through: the code step needs a fresh code.
    }
    throw new GatewayError("invalid_code");
  }
  /** The shop's current terms version; signing in accepts it, as before. */
  async function policyVersion(exchangeId: string) {
    const info = (await client!.query(anyApi.commerce.auth.exchangeInfo, {
      exchangeId,
    })) as { policyVersion: string };
    return info.policyVersion;
  }
  async function finishFlow(flow: Flow, code: string) {
    const result = (await client!.action(anyApi.commerce.auth.redeemExchange, {
      integrationId,
      secret,
      code,
      verifier: flow.verifier,
      state: flow.state,
      guest,
    })) as { session: string; expiresAt: number };
    session = result.session;
    setCookie("session", result.session, (result.expiresAt - Date.now()) / 1000);
    setCookie("signin", "", 0);
  }
  /** SHA-256 of the shopper's IP, so the backend limits attempts per address without storing it. */
  async function clientHash(): Promise<{ client?: string }> {
    const ip = request.headers.get("cf-connecting-ip");
    if (!ip) return {};
    const bytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip)),
    );
    return { client: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("") };
  }
  async function attempt<T>(work: () => Promise<T>, fallback: ShopErrorCode) {
    try {
      return await work();
    } catch (error) {
      throw new GatewayError(mapError(error, fallback));
    }
  }

  function email(raw: unknown) {
    const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (value.length > 254 || !EMAIL.test(value))
      throw new GatewayError("invalid_email");
    return value;
  }
  function password(raw: unknown) {
    if (
      typeof raw !== "string" ||
      raw.length < PASSWORD_MIN ||
      raw.length > PASSWORD_MAX
    )
      throw new GatewayError("password_rules");
    return raw;
  }
  function code(raw: unknown) {
    const value = typeof raw === "string" ? raw.replace(/\s/g, "") : "";
    if (!/^\d{6}$/.test(value)) throw new GatewayError("invalid_code");
    return value;
  }

  async function auth(
    operation: string,
    args: Record<string, unknown>,
  ): Promise<AuthStep> {
    const gateway = { integrationId, secret, ...(await clientHash()) };
    if (operation === "requestCode" || operation === "signUp" || operation === "requestReset") {
      const address = email(args.email);
      const chosen = operation === "signUp" ? password(args.password) : undefined;
      const mail = attempt(async () => {
        const flow = await beginFlow();
        const target = { ...gateway, exchangeId: flow.exchangeId, email: address };
        if (operation === "requestCode")
          await client!.action(anyApi.commerce.identity.requestCode, target);
        else if (chosen)
          await client!.action(anyApi.commerce.identity.passwordSignUp, { ...target, password: chosen });
        else await client!.action(anyApi.commerce.identity.requestReset, target);
      }, "unavailable");
      if (operation === "requestReset") {
        // Never reveal whether the email has an account; only limits and disabled methods are shown.
        await mail.catch((error: GatewayError) => {
          if (error.code === "rate_limited" || error.code === "method_disabled") throw error;
        });
        return { status: "reset-sent" };
      }
      await mail;
      return operation === "signUp" ? { status: "verify" } : { status: "code-sent" };
    }
    let flow: Flow;
    let authorized: string;
    if (operation === "signIn") {
      const address = email(args.email);
      const given = typeof args.password === "string" ? args.password : "";
      if (!given || given.length > PASSWORD_MAX)
        throw new GatewayError("invalid_credentials");
      flow = await attempt(beginFlow, "unavailable");
      const exchangeId = flow.exchangeId;
      authorized = await attempt(async () => {
        const result = (await client!.action(anyApi.commerce.identity.passwordSignIn, {
          ...gateway,
          exchangeId,
          email: address,
          password: given,
          policyVersion: await policyVersion(exchangeId),
        })) as { code: string };
        return result.code;
      }, "invalid_credentials");
    } else {
      // verifyCode, verifyEmail (after signUp) and resetPassword: the code mailed for this browser's exchange.
      const address = email(args.email);
      const value = code(args.code);
      const newPassword = operation === "resetPassword" ? password(args.password) : undefined;
      flow = savedFlow();
      const exchangeId = flow.exchangeId;
      authorized = await attempt(async () => {
        const target = {
          ...gateway,
          exchangeId,
          email: address,
          code: value,
          policyVersion: await policyVersion(exchangeId),
        };
        const result = (newPassword
          ? await client!.action(anyApi.commerce.identity.resetPassword, { ...target, password: newPassword })
          : await client!.action(anyApi.commerce.identity.verifyCode, {
              ...target,
              purpose: operation === "verifyEmail" ? "verify" : "signin",
            })) as { code: string };
        return result.code;
      }, "invalid_code");
    }
    await attempt(() => finishFlow(flow, authorized), "unavailable");
    return { status: "signed-in", state: await readState() };
  }

  async function authConfig() {
    const config = (await client!.query(anyApi.commerce.identity.storefrontAuth, {
      integrationId,
      secret,
    })) as { password: boolean; otp: boolean };
    return { password: config.password, otp: config.otp };
  }

  function field(raw: unknown, max: number, required: boolean) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if ((required && !value) || value.length > max || /[\u0000-\u001f]/.test(value))
      throw new GatewayError("invalid_address");
    return value;
  }
  function validAddress(raw: unknown, fallbackEmail?: string): Address {
    const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const phone = field(a.phone, 40, false);
    if (phone && !/^[+()\d\s.-]{5,40}$/.test(phone))
      throw new GatewayError("invalid_address");
    const country = field(a.country, 2, true).toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw new GatewayError("invalid_address");
    const region = field(a.region, 150, false);
    return {
      name: field(a.name, 150, true),
      email: fallbackEmail ?? email(a.email),
      phone,
      line1: field(a.line1, 150, true),
      line2: field(a.line2, 150, false),
      city: field(a.city, 150, true),
      postcode: field(a.postcode, 150, true),
      country,
      ...(region ? { region } : {}),
    };
  }

  /** Account details: contact name plus shipping (index 0) and optional billing (index 1) addresses. */
  async function saveProfile(args: Record<string, unknown>) {
    if (!session) throw new GatewayError("sign_in_required");
    await scoped(async (c) => {
      if (!c.session) throw new GatewayError("sign_in_required");
      const customer = (await client!.query(anyApi.commerce.shop.customer, c)) as {
        email: string;
      };
      const name = field(args.name, 150, true);
      const shipping = validAddress(args.shipping, customer.email);
      const addresses = [shipping];
      if (args.billing) addresses.push(validAddress(args.billing, customer.email));
      await client!.mutation(anyApi.commerce.shop.saveCustomerContact, { ...c, name });
      await client!.mutation(anyApi.commerce.shop.saveAddresses, { ...c, addresses });
    });
  }

  /** Stores the checkout contact and destination on the bag; signed-in shoppers may also keep it on their account. */
  async function saveCheckout(args: Record<string, unknown>) {
    await scoped(async (c) => {
      const customer = c.session
        ? ((await client!.query(anyApi.commerce.shop.customer, c)) as {
            email: string;
            name: string;
            addresses: Address[];
          })
        : null;
      const address = validAddress(args.address, customer?.email);
      for (let attempt = 0; ; attempt++) {
        const cart = (await client!.query(anyApi.commerce.shop.getCart, c)) as ServerCart | null;
        if (!cart?.lines.length) throw new GatewayError("unavailable");
        const { id: _id, revision, ...fields } = cart;
        try {
          await client!.mutation(anyApi.commerce.shop.updateCart, {
            ...c,
            expectedRevision: revision,
            cart: { ...fields, address, method: "delivery" },
          });
          break;
        } catch (error) {
          if (attempt < 2 && backendCode(error) === "CONFLICT") continue;
          throw error;
        }
      }
      if (customer && args.remember === true) {
        const [, ...rest] = customer.addresses;
        await client!.mutation(anyApi.commerce.shop.saveAddresses, {
          ...c,
          addresses: [address, ...rest].slice(0, 10),
        });
        if (!customer.name)
          await client!.mutation(anyApi.commerce.shop.saveCustomerContact, {
            ...c,
            name: address.name,
          });
      }
    });
  }

  async function body() {
    const text = await request.text();
    if (text.length > 16_000) throw new GatewayError("unavailable");
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new GatewayError("unavailable");
    const { operation, args } = raw as { operation?: unknown; args?: unknown };
    return {
      operation: String(operation),
      args:
        args && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {},
    };
  }

  async function handle(): Promise<unknown> {
    // Same-origin JSON with a custom header: cross-site forms cannot send this without CORS.
    if (
      request.headers.get("origin") !== url.origin ||
      request.headers.get("x-metal-craft-shop") !== "1" ||
      !request.headers.get("content-type")?.startsWith("application/json")
    )
      throw new GatewayError("unavailable");
    if (!client || !integrationId || !secret)
      throw new GatewayError("unavailable");
    const { operation, args } = await body();
    switch (operation) {
      case "state":
        return readState();
      case "cart":
        await updateCart(validIntent(args));
        return readState();
      case "authConfig":
        return authConfig();
      case "lookup": {
        const [config, found] = await Promise.all([
          authConfig(),
          client.mutation(anyApi.commerce.identity.lookup, {
            integrationId,
            secret,
            email: email(args.email),
          }) as Promise<{ hasPassword: boolean }>,
        ]);
        return { ...config, hasPassword: found.hasPassword } satisfies AuthLookup;
      }
      case "signIn":
      case "signUp":
      case "verifyEmail":
      case "requestReset":
      case "resetPassword":
      case "requestCode":
      case "verifyCode":
        return auth(operation, args);
      case "saveProfile":
        await saveProfile(args);
        return readState();
      case "saveCheckout":
        await saveCheckout(args);
        return readState();
      case "signOut":
        if (session)
          await client
            .mutation(anyApi.commerce.auth.logout, {
              integrationId,
              secret,
              session,
            })
            .catch(() => undefined);
        session = undefined;
        setCookie("session", "", 0);
        return readState();
      default:
        throw new GatewayError("unavailable");
    }
  }

  return {
    async respond() {
      if (request.method !== "POST")
        return new Response(null, {
          status: 405,
          headers: { Allow: "POST" },
        });
      try {
        return new Response(JSON.stringify(await handle()), { headers });
      } catch (error) {
        const code = mapError(error, "unavailable");
        if (code === "unavailable")
          console.warn(
            JSON.stringify({
              event: "metal_craft_shop_error",
              code: backendCode(error) ?? "UNKNOWN",
            }),
          );
        return new Response(JSON.stringify({ error: code }), {
          status: code === "rate_limited" ? 429 : 400,
          headers,
        });
      }
    },
  };
}
