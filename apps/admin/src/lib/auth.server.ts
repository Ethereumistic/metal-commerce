import { env } from "cloudflare:workers";
import {
  deleteCookie,
  getCookie,
  getRequestUrl,
  setCookie,
} from "@tanstack/react-start/server";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { ConvexError } from "convex/values";
import type { AdminSession, AuthErrorCode } from "./auth";

// Operators sign in with their Echoray platform account (Convex Auth on core).
// Tokens never reach the browser: they live in HttpOnly cookies, and every
// request re-checks membership of the configured business on core.

type Tokens = { token: string; refreshToken: string };
type SignInResult = { tokens?: Tokens | null; started?: boolean };

const REFRESH_MAX_AGE = 30 * 86400;
const EXPIRY_MARGIN_MS = 60_000;
// Every call to core is bounded: an unanswered sign-in check must fail as
// "unavailable" in seconds rather than hold the page (and the production
// status check that depends on it) for minutes.
const CORE_TIMEOUT_MS = 15_000;

export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode) {
    super(code);
  }
}

function config() {
  const values = env as unknown as Record<string, unknown>;
  const read = (key: string) => {
    const value = values[key];
    if (typeof value !== "string" || !value)
      throw new Error(`Missing ${key} binding`);
    return value;
  };
  return {
    backend: read("ADMIN_CONVEX_URL"),
    businessId: read("ADMIN_BUSINESS_ID"),
  };
}

function cookieNames() {
  const secure = getRequestUrl().protocol === "https:";
  const prefix = secure ? "__Host-metal-admin-" : "metal-admin-";
  return { secure, token: `${prefix}token`, refresh: `${prefix}refresh` };
}

function storeTokens(tokens: Tokens) {
  const names = cookieNames();
  const options = {
    httpOnly: true,
    secure: names.secure,
    sameSite: "lax" as const,
    path: "/",
  };
  setCookie(names.token, tokens.token, { ...options, maxAge: REFRESH_MAX_AGE });
  setCookie(names.refresh, tokens.refreshToken, {
    ...options,
    maxAge: REFRESH_MAX_AGE,
  });
}

export function clearTokens() {
  const names = cookieNames();
  deleteCookie(names.token, { path: "/", secure: names.secure });
  deleteCookie(names.refresh, { path: "/", secure: names.secure });
}

/** fetch for the core client with a deadline, still honouring any signal the client passes. */
const boundedFetch: typeof fetch = (input, init) => {
  const deadline = AbortSignal.timeout(CORE_TIMEOUT_MS);
  return fetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
};

function client(token?: string) {
  const convex = new ConvexHttpClient(config().backend, { fetch: boundedFetch });
  if (token) convex.setAuth(token);
  return convex;
}

function backendCode(error: unknown) {
  if (!(error instanceof ConvexError)) return undefined;
  const data = error.data as unknown;
  if (typeof data === "string") return data;
  return data && typeof data === "object" && "code" in data
    ? String((data as { code: unknown }).code)
    : undefined;
}

export function mapError(error: unknown): AuthErrorCode {
  if (error instanceof AuthError) return error.code;
  const code = backendCode(error);
  const message = error instanceof Error ? error.message : "";
  if (code === "POLICY_REQUIRED") return "policy_required";
  if (code === "ACCESS_DENIED") return "not_member";
  if (code === "UNAUTHENTICATED") return "invalid_credentials";
  if (/valid email/i.test(code ?? message)) return "invalid_email";
  if (/TooManyFailedAttempts|rate|limit/i.test(code ?? message))
    return "rate_limited";
  if (/InvalidSecret|InvalidAccountId|Invalid credentials/i.test(message))
    return "invalid_credentials";
  if (/code|verif/i.test(message)) return "invalid_code";
  console.warn(
    JSON.stringify({ event: "metal_admin_auth_failed", code: code ?? null }),
  );
  return "unavailable";
}

function transient(error: unknown) {
  if (error instanceof ConvexError || error instanceof AuthError) return false;
  const message = error instanceof Error ? error.message : "";
  return !/Server Error/.test(message);
}

function expiresSoon(token: string) {
  try {
    const payload = JSON.parse(
      atob(token.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/")),
    ) as { exp?: number };
    return !payload.exp || payload.exp * 1000 - EXPIRY_MARGIN_MS < Date.now();
  } catch {
    return true;
  }
}

async function signIn(args: Record<string, unknown>) {
  return (await client().action(anyApi.auth.signIn, args)) as SignInResult;
}

/** Resolves the operator for a token, or throws when they are not a member of the business. */
async function authorize(token: string): Promise<AdminSession> {
  return (await resolveOperator(token)).session;
}

async function resolveOperator(
  token: string,
): Promise<{ session: AdminSession; userId: string | null }> {
  const convex = client(token);
  const { businessId } = config();
  const [business, user] = await Promise.all([
    convex.query(anyApi.businesses.get, { businessId }) as Promise<{
      id: string;
      name: string;
      role: string;
      owner: boolean;
      canEdit: boolean;
    }>,
    convex.query(anyApi.users.me, {}) as Promise<{
      id?: string;
      name?: string;
      email?: string;
      image?: string;
    } | null>,
  ]);
  if (!business || business.id !== businessId || !user)
    throw new AuthError("not_member");
  const session: AdminSession = {
    user: {
      name: user.name ?? null,
      email: user.email ?? null,
      image: user.image ?? null,
    },
    business: {
      id: business.id,
      name: business.name,
      role: business.role,
      owner: business.owner,
      canEdit: business.canEdit,
    },
  };
  return { session, userId: user.id ?? null };
}

/** Admits freshly issued tokens only for business members; others are signed out again. */
async function admit(tokens: Tokens | null | undefined) {
  if (!tokens) throw new AuthError("invalid_code");
  try {
    const session = await authorize(tokens.token);
    storeTokens(tokens);
    return session;
  } catch (error) {
    await client(tokens.token)
      .action(anyApi.auth.signOut, {})
      .catch(() => undefined);
    throw error;
  }
}

export async function currentSession(): Promise<AdminSession | null> {
  return (await operatorSession())?.session ?? null;
}

/**
 * The signed-in operator plus a core client acting as them, for server-only
 * reads that core authorizes per user (the catalog). Neither the client nor
 * the user ID leaves the server.
 */
export async function operatorClient(): Promise<{
  session: AdminSession;
  userId: string | null;
  convex: ConvexHttpClient;
} | null> {
  const operator = await operatorSession();
  return operator
    ? {
        session: operator.session,
        userId: operator.userId,
        convex: client(operator.token),
      }
    : null;
}

async function operatorSession(): Promise<{
  session: AdminSession;
  userId: string | null;
  token: string;
} | null> {
  const names = cookieNames();
  let token = getCookie(names.token);
  const refreshToken = getCookie(names.refresh);
  if (!token || !refreshToken) return null;
  try {
    if (expiresSoon(token)) {
      const { tokens } = await signIn({ refreshToken });
      if (!tokens) {
        clearTokens();
        return null;
      }
      storeTokens(tokens);
      token = tokens.token;
    }
    return { ...(await resolveOperator(token)), token };
  } catch (error) {
    // Keep the session through network outages. Core rejections (revoked or
    // expired session, invalid refresh token, lost membership) end it.
    if (transient(error)) throw new AuthError("unavailable");
    clearTokens();
    return null;
  }
}

export async function requestEmailCode(email: string) {
  await signIn({ provider: "email-otp", params: { email } });
}

export async function verifyEmailCode(
  email: string,
  code: string,
  via: "email" | "password",
) {
  const { tokens } = await signIn(
    via === "password"
      ? {
          provider: "password",
          params: { email, code, flow: "email-verification" },
        }
      : { provider: "email-otp", params: { email, code } },
  );
  return admit(tokens);
}

/** Returns null when Echoray needs the email verified first (a code was sent). */
export async function signInWithPassword(email: string, password: string) {
  const { tokens } = await signIn({
    provider: "password",
    params: { email, password, flow: "signIn" },
  });
  return tokens ? admit(tokens) : null;
}

export async function signOut() {
  const token = getCookie(cookieNames().token);
  if (token)
    await client(token)
      .action(anyApi.auth.signOut, {})
      .catch(() => undefined);
  clearTokens();
}
