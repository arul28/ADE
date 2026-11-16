import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  activeClerkSession,
  ClerkApiError,
  ClerkFrontendApi,
  type ClerkClientState,
  type ClerkEnvironment,
  type ClerkSessionSummary,
  type ClerkSignIn,
  type ClerkSignUp,
} from "./clerkFrontendApi";
import { runClerkCaptcha, signUpNeedsCaptcha } from "./clerkCaptcha";

/**
 * What ADE's own sign-in card needs to run a Clerk sign-in on its page.
 * Built by the web shell (`WebClientRoot`), for two callers:
 *  - ADE Web's signed-out page: `finish` starts ADE Web's OAuth sign-in, which
 *    Clerk completes at once because this page just made the session;
 *  - the page a desktop or CLI sign-in opens (`/sign-in?continue=…`): `finish`
 *    goes on to that sign-in's authorize URL.
 */
export type ClerkSignInSetup = {
  /** Clerk's Frontend API origin, the same as the OAuth issuer. */
  fapiBase: string;
  /** The person signed out: end the browser's Clerk session and ask again. */
  fresh: boolean;
  /** Where Google / GitHub / Apple send the browser back to. */
  oauthReturnUrl: string;
  /** This page load is that return. */
  resumeOAuth: boolean;
  /**
   * Called once this browser holds an active Clerk session. `decorate` must
   * wrap any URL on the Clerk instance the page then navigates to.
   */
  finish: (decorate: (url: string) => string) => Promise<void> | void;
  /**
   * The URL this page loaded with, when the shell has already rewritten the
   * address bar: a development instance's OAuth return carries its dev-browser
   * id there.
   */
  landingUrl?: string;
};

export type ClerkSignInStep =
  | { kind: "loading" }
  /** Clerk cannot be reached or answered in a shape this card does not know: show Clerk's own page instead. */
  | { kind: "unavailable" }
  | { kind: "choose"; session: ClerkSessionSummary }
  | { kind: "form" }
  | { kind: "code"; email: string; flow: "sign_in" | "sign_up"; attemptId: string }
  | { kind: "finishing"; message: string };

export type ClerkSignInBusy = null | "email" | "code" | "resend" | "switch" | `oauth_${string}`;

const SELECT_ACCOUNT_STRATEGIES = new Set(["oauth_google", "oauth_github"]);

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ClerkApiError) return error.message;
  if (error instanceof Error && error.message && error.name !== "TypeError" && error.name !== "TimeoutError") {
    return error.message;
  }
  return fallback;
}

function emailCodeFactor(signIn: ClerkSignIn): string | null {
  return signIn.supportedFirstFactors.find((factor) => factor.strategy === "email_code" && factor.emailAddressId)
    ?.emailAddressId ?? null;
}

export function useClerkSignIn(setup: ClerkSignInSetup) {
  const api = useMemo(() => new ClerkFrontendApi({ fapiBase: setup.fapiBase }), [setup.fapiBase]);
  const [step, setStep] = useState<ClerkSignInStep>({ kind: "loading" });
  const [environment, setEnvironment] = useState<ClerkEnvironment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ClerkSignInBusy>(null);
  /** After "Use another account" (or a sign-out), Google and GitHub show their account picker. */
  const selectAccountRef = useRef(setup.fresh);
  const captchaBypassRef = useRef(false);
  const setupRef = useRef(setup);
  setupRef.current = setup;
  const finishedRef = useRef(false);

  const finish = useCallback(async (sessionId: string | null) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setStep({ kind: "finishing", message: "Signing you in…" });
    try {
      if (sessionId) await api.touchSession(sessionId);
      await setupRef.current.finish((url) => api.decorateNavigationUrl(url));
    } catch (cause) {
      finishedRef.current = false;
      setError(errorText(cause, "Sign-in didn't complete. Try again."));
      setStep({ kind: "form" });
    }
  }, [api]);

  const needsCaptcha = useCallback((oauthStrategy?: string | null) => (
    environment ? signUpNeedsCaptcha(environment, { captchaBypass: captchaBypassRef.current, oauthStrategy }) : false
  ), [environment]);

  /** Google / GitHub / Apple came back: finish whatever Clerk left on the client (clerk-js `_handleRedirectCallback`). */
  const resumeOAuth = useCallback(async (env: ClerkEnvironment, client: ClerkClientState) => {
    const { signIn, signUp } = client;
    if (signIn?.status === "complete" && signIn.createdSessionId) return finish(signIn.createdSessionId);
    if (signUp?.status === "complete" && signUp.createdSessionId) return finish(signUp.createdSessionId);
    const alreadySignedIn = [signIn?.firstFactorVerification, signUp?.externalAccountVerification]
      .find((verification) => verification?.errorCode === "identifier_already_signed_in" && verification.errorSessionId);
    if (alreadySignedIn?.errorSessionId) return finish(alreadySignedIn.errorSessionId);

    // An account that already exists came through the sign-up side.
    if (signUp?.externalAccountVerification.status === "transferable"
      && signUp.externalAccountVerification.errorCode === "external_account_exists") {
      const transferred = await api.createSignIn({ transfer: true });
      if (transferred.status === "complete" && transferred.createdSessionId) return finish(transferred.createdSessionId);
      throw new ClerkApiError({ code: "transfer_incomplete", message: "Sign-in didn't complete. Try another way.", status: 200 });
    }

    // A new person: their provider account becomes an ADE account.
    if (signIn?.firstFactorVerification.status === "transferable") {
      const strategy = signIn.firstFactorVerification.strategy;
      const captcha = signUpNeedsCaptcha(env, { captchaBypass: client.captchaBypass, oauthStrategy: strategy })
        ? await runClerkCaptcha(env)
        : {};
      const created = await api.createSignUp({ transfer: true, ...captcha });
      if (created.status === "complete" && created.createdSessionId) return finish(created.createdSessionId);
      throw new ClerkApiError({
        code: "sign_up_incomplete",
        message: "Your account needs a step this page can't show. Use email instead, or try again.",
        status: 200,
      });
    }

    const failure = signIn?.firstFactorVerification.errorMessage ?? signUp?.externalAccountVerification.errorMessage;
    const session = activeClerkSession(client);
    if (!failure && session) return finish(session.id);
    throw new ClerkApiError({ code: "oauth_incomplete", message: failure ?? "Sign-in didn't complete. Try again.", status: 200 });
  }, [api, finish]);

  useEffect(() => {
    let cancelled = false;
    finishedRef.current = false;
    void (async () => {
      try {
        const landingUrl = setupRef.current.landingUrl;
        api.adoptDevBrowserFromUrl(
          { href: landingUrl ?? window.location.href },
          landingUrl ? () => undefined : (url) => window.history.replaceState(null, "", url),
        );
        const [env, initialClient] = await Promise.all([api.environment(), api.client()]);
        if (cancelled) return;
        if (!env.emailCodeEnabled && env.socialStrategies.length === 0) {
          setStep({ kind: "unavailable" });
          return;
        }
        setEnvironment(env);
        captchaBypassRef.current = initialClient.captchaBypass;
        if (setupRef.current.resumeOAuth) {
          setStep({ kind: "finishing", message: "Finishing sign-in…" });
          try {
            await resumeOAuth(env, initialClient);
          } catch (cause) {
            if (cancelled) return;
            setError(errorText(cause, "Sign-in didn't complete. Try again."));
            setStep({ kind: "form" });
          }
          return;
        }
        let client = initialClient;
        if (setupRef.current.fresh && client.sessions.length > 0) {
          client = await api.removeSessions();
          if (cancelled) return;
        }
        const session = activeClerkSession(client);
        setStep(session ? { kind: "choose", session } : { kind: "form" });
      } catch {
        if (!cancelled) setStep({ kind: "unavailable" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, resumeOAuth]);

  const run = useCallback(async (label: ClerkSignInBusy, work: () => Promise<void>, fallback: string) => {
    setBusy(label);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(errorText(cause, fallback));
    } finally {
      setBusy(null);
    }
  }, []);

  /** Clears a session left from before so a new sign-in can start (Clerk keeps one session per browser). */
  const withFreshClient = useCallback(async <T,>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (cause) {
      if (cause instanceof ClerkApiError && cause.code === "session_exists") {
        await api.removeSessions();
        return await work();
      }
      throw cause;
    }
  }, [api]);

  const continueWithProvider = useCallback((strategy: string) => run(`oauth_${strategy}`, async () => {
    const returnUrl = setupRef.current.oauthReturnUrl;
    const signIn = await withFreshClient(() => api.createSignIn({
      strategy,
      redirect_url: returnUrl,
      action_complete_redirect_url: returnUrl,
      oidc_prompt: selectAccountRef.current && SELECT_ACCOUNT_STRATEGIES.has(strategy) ? "select_account" : undefined,
    }));
    const next = signIn.firstFactorVerification.externalVerificationRedirectUrl;
    if (!next) throw new ClerkApiError({ code: "no_redirect", message: "That sign-in option isn't available right now.", status: 200 });
    window.location.assign(next);
    // Keep the button busy while the browser leaves.
    await new Promise(() => undefined);
  }, "That sign-in option isn't available right now. Try another."), [api, run, withFreshClient]);

  const startSignUp = useCallback(async (email: string): Promise<ClerkSignUp> => {
    const captcha = needsCaptcha(null) && environment ? await runClerkCaptcha(environment) : {};
    const created = await api.createSignUp({ email_address: email, ...captcha });
    return await api.prepareSignUpEmailCode(created.id);
  }, [api, environment, needsCaptcha]);

  const submitEmail = useCallback((rawEmail: string) => run("email", async () => {
    const email = rawEmail.trim();
    if (!email) throw new ClerkApiError({ code: "email_required", message: "Enter your email address.", status: 0 });
    let signIn: ClerkSignIn | null = null;
    try {
      signIn = await withFreshClient(() => api.createSignIn({ identifier: email }));
    } catch (cause) {
      if (!(cause instanceof ClerkApiError) || cause.code !== "form_identifier_not_found") throw cause;
    }
    if (!signIn) {
      const signUp = await startSignUp(email);
      setStep({ kind: "code", email, flow: "sign_up", attemptId: signUp.id });
      return;
    }
    const emailAddressId = emailCodeFactor(signIn);
    if (!emailAddressId) {
      throw new ClerkApiError({
        code: "no_email_code",
        message: "This account signs in with Google, GitHub or Apple. Use one of those above.",
        status: 0,
      });
    }
    const prepared = await api.prepareSignInEmailCode(signIn.id, emailAddressId);
    setStep({ kind: "code", email, flow: "sign_in", attemptId: prepared.id });
  }, "Couldn't send a code to that address. Check it and try again."), [api, run, startSignUp, withFreshClient]);

  const submitCode = useCallback((rawCode: string) => run("code", async () => {
    if (step.kind !== "code") return;
    const code = rawCode.replace(/\s+/g, "");
    if (!code) throw new ClerkApiError({ code: "code_required", message: "Enter the code from the email.", status: 0 });
    if (step.flow === "sign_in") {
      const result = await api.attemptSignInEmailCode(step.attemptId, code);
      if (result.status === "complete" && result.createdSessionId) return finish(result.createdSessionId);
      throw new ClerkApiError({ code: "sign_in_incomplete", message: "Your account needs another step. Try Google, GitHub or Apple.", status: 0 });
    }
    const result = await api.attemptSignUpEmailCode(step.attemptId, code);
    if (result.status === "complete" && result.createdSessionId) return finish(result.createdSessionId);
    throw new ClerkApiError({ code: "sign_up_incomplete", message: "Your account needs another step. Try Google, GitHub or Apple.", status: 0 });
  }, "That code didn't work. Check it and try again."), [api, finish, run, step]);

  const resendCode = useCallback(() => run("resend", async () => {
    if (step.kind !== "code") return;
    if (step.flow === "sign_up") {
      await api.prepareSignUpEmailCode(step.attemptId);
      return;
    }
    const client = await api.client();
    const emailAddressId = client.signIn ? emailCodeFactor(client.signIn) : null;
    if (!client.signIn || !emailAddressId) throw new ClerkApiError({ code: "sign_in_gone", message: "Start again with your email.", status: 0 });
    await api.prepareSignInEmailCode(client.signIn.id, emailAddressId);
  }, "Couldn't send a new code. Try again in a moment."), [api, run, step]);

  const continueAsCurrent = useCallback(() => {
    if (step.kind !== "choose") return;
    void finish(step.session.id);
  }, [finish, step]);

  const switchAccount = useCallback(() => run("switch", async () => {
    await api.removeSessions();
    selectAccountRef.current = true;
    setStep({ kind: "form" });
  }, "Couldn't sign out of that account. Try again."), [api, run]);

  const backToForm = useCallback(() => {
    setError(null);
    setStep({ kind: "form" });
  }, []);

  return {
    step,
    environment,
    error,
    busy,
    continueWithProvider,
    submitEmail,
    submitCode,
    resendCode,
    continueAsCurrent,
    switchAccount,
    backToForm,
  };
}
