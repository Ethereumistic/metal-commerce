import { useState, type FormEvent } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Loader2, Store } from "lucide-react";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field";
import { Input } from "@workspace/ui/components/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@workspace/ui/components/input-otp";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  getSession,
  passwordSignIn,
  requestCode,
  verifyCode,
  type AuthErrorCode,
  type AuthResult,
} from "@/lib/auth";

const DASHBOARD_URL = "https://dev.echoray.io/dashboard";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { next?: string } =>
    typeof search.next === "string" && /^\/[a-z0-9/-]*$/i.test(search.next)
      ? { next: search.next }
      : {},
  beforeLoad: async ({ search }) => {
    if (await getSession()) throw redirect({ to: search.next ?? "/" });
  },
  head: () => ({ meta: [{ title: "Sign in · Metal Craft Admin" }] }),
  component: Login,
});

const messages: Record<AuthErrorCode, string> = {
  invalid_email: "Enter a valid email address.",
  invalid_code: "That code is invalid or has expired.",
  invalid_credentials: "Email or password is incorrect.",
  not_member:
    "This Echoray account is not a member of the Metal Craft business.",
  policy_required:
    "Accept the latest Echoray policies in the Echoray dashboard, then try again.",
  rate_limited: "Too many attempts. Wait a moment and try again.",
  unavailable: "Sign-in is temporarily unavailable. Try again shortly.",
};

type Step =
  | { kind: "email" }
  | { kind: "password" }
  | { kind: "code"; via: "email" | "password" };

function Login() {
  const router = useRouter();
  const { next } = Route.useSearch();
  const [step, setStep] = useState<Step>({ kind: "email" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthErrorCode | null>(null);

  async function run<T>(
    work: () => Promise<AuthResult<T>>,
    done: (value: T) => Promise<void> | void,
  ) {
    setBusy(true);
    setError(null);
    try {
      const result = await work();
      if (result.ok) await done(result.value);
      else setError(result.error);
    } catch {
      setError("unavailable");
    } finally {
      setBusy(false);
    }
  }

  async function enter() {
    await router.invalidate();
    await router.navigate({ to: next ?? "/" });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (step.kind === "email")
      return run(
        () => requestCode({ data: { email } }),
        () => {
          setCode("");
          setStep({ kind: "code", via: "email" });
        },
      );
    if (step.kind === "password")
      return run(
        () => passwordSignIn({ data: { email, password } }),
        async (session) => {
          if (session) return enter();
          // Echoray emailed a verification code before allowing password sign-in.
          setCode("");
          setStep({ kind: "code", via: "password" });
        },
      );
    return run(
      () => verifyCode({ data: { email, code, via: step.via } }),
      enter,
    );
  }

  return (
    <main className="relative flex min-h-svh items-center justify-center bg-muted p-6 md:p-10">
      <ThemeToggle className="absolute top-4 right-4" />
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center gap-2 self-center font-medium">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Store className="size-4" />
          </div>
          Metal Craft Admin
        </div>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">
              {step.kind === "code" ? "Check your email" : "Sign in"}
            </CardTitle>
            <CardDescription>
              {step.kind === "code"
                ? `Enter the 6-digit code sent to ${email}.`
                : "Use your Echoray account. Only members of the Metal Craft business can sign in."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit}>
              <FieldGroup>
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>
                      {messages[error]}
                      {error === "policy_required" && (
                        <>
                          {" "}
                          <a
                            className="underline"
                            href={DASHBOARD_URL}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open Echoray
                          </a>
                        </>
                      )}
                    </AlertDescription>
                  </Alert>
                )}

                {step.kind === "code" ? (
                  <Field>
                    <FieldLabel htmlFor="code" className="sr-only">
                      Verification code
                    </FieldLabel>
                    <InputOTP
                      id="code"
                      maxLength={6}
                      value={code}
                      onChange={setCode}
                      autoFocus
                      containerClassName="justify-center"
                    >
                      <InputOTPGroup>
                        {Array.from({ length: 6 }, (_, index) => (
                          <InputOTPSlot key={index} index={index} />
                        ))}
                      </InputOTPGroup>
                    </InputOTP>
                    <FieldDescription className="text-center">
                      The code expires in 5 minutes.
                    </FieldDescription>
                  </Field>
                ) : (
                  <Field>
                    <FieldLabel htmlFor="email">Email</FieldLabel>
                    <Input
                      id="email"
                      type="email"
                      autoComplete="email"
                      placeholder="you@example.com"
                      required
                      autoFocus
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  </Field>
                )}

                {step.kind === "password" && (
                  <Field>
                    <FieldLabel htmlFor="password">Password</FieldLabel>
                    <Input
                      id="password"
                      type="password"
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </Field>
                )}

                <Field>
                  <Button
                    type="submit"
                    disabled={busy || (step.kind === "code" && code.length < 6)}
                  >
                    {busy && <Loader2 className="animate-spin" />}
                    {step.kind === "email"
                      ? "Email me a sign-in code"
                      : step.kind === "password"
                        ? "Sign in"
                        : "Verify and continue"}
                  </Button>
                  {step.kind === "email" && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setError(null);
                        setStep({ kind: "password" });
                      }}
                    >
                      Use a password instead
                    </Button>
                  )}
                  {step.kind !== "email" && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setError(null);
                        setStep({ kind: "email" });
                      }}
                    >
                      {step.kind === "code"
                        ? "Use a different email"
                        : "Email me a code instead"}
                    </Button>
                  )}
                </Field>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
