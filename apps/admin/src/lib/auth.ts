import { createServerFn } from "@tanstack/react-start";

export type AuthErrorCode =
  | "invalid_email"
  | "invalid_code"
  | "invalid_credentials"
  | "not_member"
  | "policy_required"
  | "rate_limited"
  | "unavailable";

export type AdminSession = {
  user: { name: string | null; email: string | null; image: string | null };
  business: {
    id: string;
    name: string;
    role: string;
    owner: boolean;
    canEdit: boolean;
  };
};

export type AuthResult<T = AdminSession> =
  | { ok: true; value: T }
  | { ok: false; error: AuthErrorCode };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function email(value: unknown) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized.length > 254 || !EMAIL.test(normalized))
    throw new Error("Invalid email");
  return normalized;
}
function text(value: unknown, max: number) {
  if (typeof value !== "string" || !value || value.length > max)
    throw new Error("Invalid input");
  return value;
}
function input(data: unknown) {
  return (data && typeof data === "object" ? data : {}) as Record<
    string,
    unknown
  >;
}

async function attempt<T>(work: () => Promise<T>): Promise<AuthResult<T>> {
  const { mapError } = await import("./auth.server");
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: mapError(error) };
  }
}

export const getSession = createServerFn({ method: "GET" }).handler(
  async () => {
    const { currentSession } = await import("./auth.server");
    return currentSession();
  },
);

export const requestCode = createServerFn({ method: "POST" })
  .validator((data: unknown) => ({ email: email(input(data).email) }))
  .handler(async ({ data }) => {
    const auth = await import("./auth.server");
    return attempt(async () => {
      await auth.requestEmailCode(data.email);
      return true as const;
    });
  });

export const verifyCode = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const values = input(data);
    return {
      email: email(values.email),
      code: text(values.code, 16),
      via: values.via === "password" ? ("password" as const) : ("email" as const),
    };
  })
  .handler(async ({ data }) => {
    const auth = await import("./auth.server");
    return attempt(() => auth.verifyEmailCode(data.email, data.code, data.via));
  });

export const passwordSignIn = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const values = input(data);
    return { email: email(values.email), password: text(values.password, 128) };
  })
  .handler(async ({ data }) => {
    const auth = await import("./auth.server");
    return attempt(() => auth.signInWithPassword(data.email, data.password));
  });

export const signOut = createServerFn({ method: "POST" }).handler(async () => {
  const auth = await import("./auth.server");
  await auth.signOut();
  return true;
});
