import { lazy, Suspense, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AppleLogo, ArrowRight, CircleNotch, GithubLogo } from "@phosphor-icons/react";
import { CLERK_CAPTCHA_ELEMENT_ID } from "../../webclient/account/clerkCaptcha";
import { useClerkSignIn, type ClerkSignInSetup } from "../../webclient/account/useClerkSignIn";

const PROVIDER_ORDER = ["oauth_google", "oauth_github", "oauth_apple"] as const;
const PROVIDER_LABEL: Record<string, string> = {
  oauth_google: "Google",
  oauth_github: "GitHub",
  oauth_apple: "Apple",
};
const RESEND_COOLDOWN_SEC = 30;

// Loads only when an error shows, like the rest of the card's notices.
const Banner = lazy(() => import("../ui/notice/Banner").then((module) => ({ default: module.Banner })));

/** Google asks for its four-colour mark on a sign-in button. */
function GoogleMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function ProviderIcon({ strategy }: { strategy: string }) {
  if (strategy === "oauth_google") return <GoogleMark />;
  if (strategy === "oauth_github") return <GithubLogo size={18} weight="fill" />;
  if (strategy === "oauth_apple") return <AppleLogo size={18} weight="fill" />;
  return null;
}

/** Counts down from `seconds` each time `key` changes; no timer runs while `key` is null. */
function useCountdown(seconds: number, key: string | null): number {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    setLeft(seconds);
    if (key === null) return;
    const timer = window.setInterval(() => {
      setLeft((value) => {
        if (value <= 1) window.clearInterval(timer);
        return Math.max(0, value - 1);
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [seconds, key]);
  return left;
}

/**
 * ADE's own Clerk sign-in inside the glass card: Google, GitHub and Apple, an
 * email code, and "Continue as" when this browser already has a Clerk
 * session. `onUnavailable` hands back to the card's one-button sign-in, which
 * opens Clerk's hosted page.
 */
export function ClerkSignInPanel({
  setup,
  onUnavailable,
}: {
  setup: ClerkSignInSetup;
  onUnavailable: () => void;
}) {
  const flow = useClerkSignIn(setup);
  const { step, environment, error, busy } = flow;
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  const codeKey = step.kind === "code" ? step.attemptId : null;
  const resendLeft = useCountdown(RESEND_COOLDOWN_SEC, step.kind === "code" ? `${step.attemptId}:${step.sends}` : null);

  useEffect(() => {
    if (step.kind === "unavailable") onUnavailable();
  }, [onUnavailable, step.kind]);

  useEffect(() => {
    if (codeKey) {
      setCode("");
      codeInputRef.current?.focus();
    }
  }, [codeKey]);

  const anyBusy = busy !== null;
  const providers = PROVIDER_ORDER.filter((strategy) => environment?.socialStrategies.includes(strategy));

  const onSubmitEmail = (event: FormEvent) => {
    event.preventDefault();
    void flow.submitEmail(email);
  };
  const onSubmitCode = (event: FormEvent) => {
    event.preventDefault();
    void flow.submitCode(code);
  };

  let body: ReactNode;
  if (step.kind === "loading" || step.kind === "unavailable") {
    body = (
      <div className="ade-clerk-status" role="status">
        <CircleNotch size={16} weight="bold" className="animate-spin" />
        Loading sign-in…
      </div>
    );
  } else if (step.kind === "finishing") {
    body = (
      <div className="ade-clerk-status" role="status">
        <CircleNotch size={16} weight="bold" className="animate-spin" />
        {step.message}
      </div>
    );
  } else if (step.kind === "choose") {
    const who = step.session.name ?? step.session.email ?? "your account";
    body = (
      <div className="ade-clerk-stack">
        <div className="ade-clerk-account">
          {step.session.imageUrl ? (
            <img src={step.session.imageUrl} alt="" className="ade-clerk-avatar" referrerPolicy="no-referrer" />
          ) : (
            <span className="ade-clerk-avatar ade-clerk-avatar-initial" aria-hidden="true">
              {(who.trim()[0] ?? "A").toUpperCase()}
            </span>
          )}
          <span className="ade-clerk-account-text">
            {step.session.name ? <strong>{step.session.name}</strong> : null}
            {step.session.email ? <span>{step.session.email}</span> : null}
          </span>
        </div>
        <button type="button" className="ade-glass-primary" disabled={anyBusy} onClick={flow.continueAsCurrent}>
          {/* The row above names the account; a long email would wrap the button. */}
          {step.session.name ? `Continue as ${step.session.name.split(" ")[0]}` : "Continue"}
          <ArrowRight size={16} weight="bold" className="ade-glass-primary-arrow" />
        </button>
        <button type="button" className="ade-glass-link ade-clerk-centered" disabled={anyBusy} onClick={() => void flow.switchAccount()}>
          {busy === "switch" ? <CircleNotch size={13} weight="bold" className="animate-spin" /> : null}
          Use another account
        </button>
      </div>
    );
  } else if (step.kind === "code") {
    body = (
      <form className="ade-clerk-stack" onSubmit={onSubmitCode} noValidate>
        <p className="ade-clerk-hint">
          Enter the code we sent to <strong>{step.email}</strong>.
        </p>
        <label className="ade-clerk-sr" htmlFor="ade-clerk-code">Code from the email</label>
        <input
          id="ade-clerk-code"
          ref={codeInputRef}
          className="ade-clerk-input ade-clerk-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={8}
          placeholder="000000"
          value={code}
          onChange={(event) => {
            const next = event.target.value.replace(/\D+/g, "").slice(0, 8);
            setCode(next);
            if (next.length === 6 && !anyBusy) void flow.submitCode(next);
          }}
          disabled={busy === "code"}
        />
        <button type="submit" className="ade-glass-primary" disabled={anyBusy || code.length < 6}>
          {busy === "code" ? <CircleNotch size={16} weight="bold" className="animate-spin" /> : null}
          {step.flow === "sign_up" ? "Create account" : "Sign in"}
        </button>
        <div className="ade-clerk-row">
          <button type="button" className="ade-glass-link" disabled={anyBusy} onClick={flow.backToForm}>
            Use a different email
          </button>
          <button
            type="button"
            className="ade-glass-link"
            disabled={anyBusy || resendLeft > 0}
            onClick={() => void flow.resendCode()}
          >
            {resendLeft > 0 ? `Resend code in ${resendLeft}s` : "Resend code"}
          </button>
        </div>
      </form>
    );
  } else {
    body = (
      <div className="ade-clerk-stack">
        {providers.length > 0 ? (
          <div className="ade-clerk-providers">
            {providers.map((strategy) => (
              <button
                key={strategy}
                type="button"
                className="ade-glass-secondary ade-clerk-provider"
                disabled={anyBusy}
                onClick={() => void flow.continueWithProvider(strategy)}
              >
                {busy === `oauth_${strategy}` ? (
                  <CircleNotch size={16} weight="bold" className="animate-spin" />
                ) : (
                  <ProviderIcon strategy={strategy} />
                )}
                Continue with {PROVIDER_LABEL[strategy]}
              </button>
            ))}
          </div>
        ) : null}
        {environment?.emailCodeEnabled ? (
          <>
            {providers.length > 0 ? <div className="ade-clerk-divider"><span>or</span></div> : null}
            <form className="ade-clerk-stack" onSubmit={onSubmitEmail} noValidate>
              <label className="ade-clerk-sr" htmlFor="ade-clerk-email">Email address</label>
              <input
                id="ade-clerk-email"
                className="ade-clerk-input"
                type="email"
                inputMode="email"
                autoComplete="email"
                spellCheck={false}
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={anyBusy}
              />
              <button type="submit" className="ade-glass-primary" disabled={anyBusy || !email.trim()}>
                {busy === "email" ? <CircleNotch size={16} weight="bold" className="animate-spin" /> : null}
                Continue with email
                {busy === "email" ? null : <ArrowRight size={16} weight="bold" className="ade-glass-primary-arrow" />}
              </button>
            </form>
          </>
        ) : null}
        <p className="ade-clerk-foot">New to ADE? The same steps create your account.</p>
      </div>
    );
  }

  return (
    <div className="ade-clerk" data-step={step.kind}>
      {body}
      {error ? (
        <Suspense fallback={null}>
          <Banner
            layout="inline"
            style={{ marginTop: 12 }}
            // A wrong code or a mistyped email is the person's to fix, not a
            // defect: `report: false` keeps it out of Sentry Logs. A real
            // failure of the card is reported where it falls back.
            model={{ id: "clerk-sign-in-error", tone: "error", title: error, report: false }}
          />
        </Suspense>
      ) : null}
      {/* Clerk's sign-up bot check renders here, and only shows when Cloudflare wants a click. */}
      <div id={CLERK_CAPTCHA_ELEMENT_ID} className="ade-clerk-captcha" />
    </div>
  );
}
