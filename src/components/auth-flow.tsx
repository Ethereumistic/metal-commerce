import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCart } from "@/lib/cart-store";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  shopCall,
  ShopError,
  type AuthConfig,
  type AuthLookup,
  type AuthStep,
  type ShopErrorCode,
} from "@/lib/shop";
import { m } from "@/paraglide/messages";

export const errorText: Record<ShopErrorCode, () => string> = {
  invalid_credentials: m.error_invalid_credentials,
  invalid_code: m.error_invalid_code,
  account_exists: m.error_account_exists,
  password_rules: m.error_password_rules,
  invalid_email: m.error_invalid_email,
  rate_limited: m.error_rate_limited,
  method_disabled: m.error_method_disabled,
  invalid_address: m.error_invalid_address,
  sign_in_required: m.error_sign_in_required,
  unavailable: m.error_unavailable,
};

/**
 * Identifier-first sign-in: email first, then the shop decides whether the
 * shopper enters a password, creates one, or receives a one-time code.
 */
type Step =
  | "email"
  | "password"
  | "create"
  | "verify"
  | "code"
  | "reset"
  | "resetCode";

export function AuthFlow({
  onSignedIn,
  autoFocus = true,
}: {
  onSignedIn?: () => void;
  autoFocus?: boolean;
}) {
  const accept = useCart((state) => state.accept);
  const [step, setStep] = useState<Step>("email");
  const [config, setConfig] = useState<AuthConfig>({ password: true, otp: false });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ShopErrorCode>();
  const [notice, setNotice] = useState("");

  function go(next: Step) {
    setStep(next);
    setError(undefined);
    setNotice("");
    setCode("");
    if (next === "email" || next === "reset") setPassword("");
  }
  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setNotice("");
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof ShopError ? failure.code : "unavailable");
    } finally {
      setBusy(false);
    }
  }
  async function auth(operation: string, args: Record<string, unknown>) {
    const result = await shopCall<AuthStep>(operation, args);
    if (result.status === "signed-in") {
      setPassword("");
      accept(result.state);
      onSignedIn?.();
    } else if (result.status === "verify") go("verify");
    else if (result.status === "code-sent") go("code");
    else go("resetCode");
  }
  const sendCode = () => auth("requestCode", { email });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      if (step === "email") {
        const found = await shopCall<AuthLookup>("lookup", { email });
        setConfig(found);
        if (found.password) go(found.hasPassword ? "password" : "create");
        else await sendCode();
      } else if (step === "password") await auth("signIn", { email, password });
      else if (step === "create") await auth("signUp", { email, password });
      else if (step === "verify") await auth("verifyEmail", { email, code });
      else if (step === "code") await auth("verifyCode", { email, code });
      else if (step === "reset") await auth("requestReset", { email });
      else await auth("resetPassword", { email, code, password });
    });
  }

  const title = {
    email: m.auth_email_title(),
    password: m.auth_welcome_back(),
    create: m.auth_create_title(),
    verify: m.account_verify_title(),
    code: m.auth_code_title(),
    reset: m.account_reset_title(),
    resetCode: m.account_reset_title(),
  }[step];
  const body = {
    email: m.auth_email_body(),
    password: m.auth_password_body(),
    create: m.auth_create_body(),
    verify: m.account_verify_body({ email }),
    code: m.auth_code_body({ email }),
    reset: m.account_reset_body(),
    resetCode: m.account_reset_code_body({ email }),
  }[step];
  const action = {
    email: m.auth_continue(),
    password: m.account_sign_in(),
    create: m.account_create(),
    verify: m.account_verify(),
    code: m.account_sign_in(),
    reset: m.account_reset_send(),
    resetCode: m.account_reset_save(),
  }[step];
  const choosingPassword = step === "create" || step === "resetCode";
  const codeStep = step === "verify" || step === "code" || step === "resetCode";

  return (
    <form className="account-form" onSubmit={submit}>
      <div className="auth-heading">
        <h2>{title}</h2>
        <p className="account-lede">{body}</p>
      </div>
      {step === "email" ? (
        <Field label={m.account_email()}>
          {(id) => (
            <Input
              id={id}
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              required
              maxLength={254}
              autoFocus={autoFocus}
              value={email}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
              className="moris-input"
            />
          )}
        </Field>
      ) : (
        <div className="auth-identity">
          <span>{email}</span>
          <button type="button" className="account-switch" disabled={busy} onClick={() => go("email")}>
            {m.auth_change_email()}
          </button>
        </div>
      )}
      {codeStep && (
        <Field label={m.account_code()}>
          {(id) => (
            <Input
              id={id}
              name="code"
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
              value={code}
              disabled={busy}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              className="moris-input moris-code"
            />
          )}
        </Field>
      )}
      {(step === "password" || choosingPassword) && (
        <PasswordField
          label={step === "resetCode" ? m.account_new_password() : m.account_password()}
          value={password}
          onChange={setPassword}
          disabled={busy}
          isNew={choosingPassword}
          autoFocus={step !== "resetCode"}
        />
      )}
      {step === "password" && (
        <button type="button" className="account-inline-link" onClick={() => go("reset")}>
          {m.account_forgot()}
        </button>
      )}
      {error && (
        <p className="account-error" role="alert">
          {errorText[error]()}
        </p>
      )}
      {notice && (
        <p className="account-note" role="status">
          {notice}
        </p>
      )}
      <button type="submit" className="moris-button" disabled={busy}>
        {busy ? m.account_working() : action}
      </button>
      {step === "create" && <p className="account-note">{m.account_consent()}</p>}
      {(step === "password" || step === "create") && config.otp && (
        <button
          type="button"
          className="account-switch auth-alternative"
          disabled={busy}
          onClick={() => void run(sendCode)}
        >
          {m.auth_code_instead()}
        </button>
      )}
      {(step === "code" || step === "verify") && (
        <button
          type="button"
          className="account-switch auth-alternative"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              // Signing in to an unverified password account mails a fresh verification code.
              await shopCall<AuthStep>(
                step === "code" ? "requestCode" : "signIn",
                step === "code" ? { email } : { email, password },
              );
              setNotice(m.auth_code_resent());
            })
          }
        >
          {m.auth_resend()}
        </button>
      )}
      {(step === "reset" || step === "resetCode") && (
        <button type="button" className="account-switch" onClick={() => go("password")}>
          <ArrowLeft size={15} />
          {m.account_back()}
        </button>
      )}
    </form>
  );
}

/** The same flow in a dialog, so checkout never loses its place. */
export function AuthDialog({
  open,
  onOpenChange,
  onSignedIn,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSignedIn?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="auth-dialog">
        <DialogTitle className="sr-only">{m.auth_email_title()}</DialogTitle>
        <DialogDescription className="sr-only">{m.auth_email_body()}</DialogDescription>
        {open && (
          <AuthFlow
            onSignedIn={() => {
              onOpenChange(false);
              onSignedIn?.();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: (id: string) => ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={className ? `moris-field ${className}` : "moris-field"}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <p className="small-label">{hint}</p>}
    </div>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  disabled,
  isNew,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  isNew: boolean;
  autoFocus?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => setVisible(false), [label]);
  return (
    <Field label={label} hint={isNew ? m.account_password_hint() : undefined}>
      {(id) => (
        <div className="password-wrap">
          <Input
            id={id}
            name="password"
            type={visible ? "text" : "password"}
            autoComplete={isNew ? "new-password" : "current-password"}
            required
            minLength={isNew ? PASSWORD_MIN : undefined}
            maxLength={PASSWORD_MAX}
            autoFocus={autoFocus}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            className="moris-input"
          />
          <button
            type="button"
            className="password-toggle"
            aria-label={visible ? m.account_hide_password() : m.account_show_password()}
            aria-pressed={visible}
            onClick={() => setVisible((shown) => !shown)}
          >
            {visible ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
        </div>
      )}
    </Field>
  );
}
