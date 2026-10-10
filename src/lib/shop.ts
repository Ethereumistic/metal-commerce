// Client-safe shop contract shared by the Worker gateway and the browser.

export type CartAnswer = { key: string; value: string };
export type CartLine = {
  productId: string;
  variantKey: string;
  offerKey?: string;
  quantity: number;
  answers: CartAnswer[];
};
export type CartItem = CartLine & {
  name: string;
  slug: string;
  variantLabel: string;
  unitAmount: number;
  currency: string;
  image?: string;
  madeToOrder: boolean;
  leadMinDays: number;
  leadMaxDays: number;
};
export type CartTotals = {
  currency: string;
  subtotal: number;
  discount: number;
  shipping: number;
  tax: number;
  total: number;
};
export type Address = {
  name: string;
  email: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  postcode: string;
  country: string;
  region?: string;
};
/** Saved account addresses: index 0 is shipping, index 1 (optional) is billing. */
export type ShopAccount = {
  email: string;
  name: string;
  shipping?: Address;
  billing?: Address;
};
export type ShopState = {
  items: CartItem[];
  account: ShopAccount | null;
  /** Destination already saved on the bag for checkout. */
  address?: Address;
  totals?: CartTotals;
  payable?: boolean;
};
export type AuthConfig = { password: boolean; otp: boolean };
export type AuthLookup = AuthConfig & { hasPassword: boolean };
export const emptyAddress = (email = "", name = ""): Address => ({
  name,
  email,
  phone: "",
  line1: "",
  line2: "",
  city: "",
  postcode: "",
  country: "",
  region: "",
});
export type CartIntent =
  | { kind: "add"; line: CartLine }
  | { kind: "quantity"; key: string; quantity: number }
  | { kind: "remove"; key: string };

export type AuthStep =
  | { status: "signed-in"; state: ShopState }
  | { status: "verify" }
  | { status: "code-sent" }
  | { status: "reset-sent" };

/** Error codes the gateway returns; the UI owns the localized wording. */
export type ShopErrorCode =
  | "invalid_credentials"
  | "invalid_code"
  | "account_exists"
  | "password_rules"
  | "invalid_email"
  | "rate_limited"
  | "method_disabled"
  | "invalid_address"
  | "sign_in_required"
  | "unavailable";

export const MAX_LINE_QUANTITY = 20;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export function lineKey(
  line: Pick<CartLine, "productId" | "variantKey" | "offerKey" | "answers">,
) {
  return JSON.stringify([
    line.productId,
    line.variantKey,
    line.offerKey ?? "",
    line.answers,
  ]);
}

export function applyIntent<T extends CartLine>(
  lines: T[],
  intent: CartIntent,
  added?: (line: CartLine) => T,
): T[] {
  if (intent.kind === "add") {
    const key = lineKey(intent.line);
    if (lines.some((line) => lineKey(line) === key))
      return lines.map((line) =>
        lineKey(line) === key
          ? {
              ...line,
              quantity: Math.min(
                MAX_LINE_QUANTITY,
                line.quantity + intent.line.quantity,
              ),
            }
          : line,
      );
    return added ? [...lines, added(intent.line)] : lines;
  }
  if (intent.kind === "remove")
    return lines.filter((line) => lineKey(line) !== intent.key);
  return lines.map((line) =>
    lineKey(line) === intent.key ? { ...line, quantity: intent.quantity } : line,
  );
}

export class ShopError extends Error {
  constructor(readonly code: ShopErrorCode) {
    super(code);
  }
}

/** Same-origin JSON call into the Worker gateway. The custom header forces CORS preflight. */
export async function shopCall<T>(
  operation: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/shop", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-Moris-Shop": "1",
      },
      body: JSON.stringify({ operation, args }),
    });
  } catch {
    throw new ShopError("unavailable");
  }
  const data = (await response.json().catch(() => null)) as
    | (T & { error?: ShopErrorCode })
    | null;
  if (!response.ok || !data || (data as { error?: string }).error)
    throw new ShopError(data?.error ?? "unavailable");
  return data;
}
