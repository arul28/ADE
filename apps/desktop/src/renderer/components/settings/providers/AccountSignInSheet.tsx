/**
 * The Claude Code and Codex account sheet: an account's own login in a
 * private PTY on its machine (`providerInstances.login*`), drawn in the
 * shared sign-in frame. `useAccountSignInSheet` hosts it on the Settings
 * page's machine.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ShieldCheck } from "@phosphor-icons/react";
import { Banner } from "../../ui/notice/Banner";
import { isWebClientMode } from "../../../lib/webClientMode";
import { isUnsupportedAdeActionError } from "../../../../shared/codedError";
import { isProviderLoginLive } from "../../../../shared/types";
import type { ProviderInstance, ProviderInstanceProvider, ProviderLoginStatus } from "../../../../shared/types/providerInstances";
import { accountIdentityLine } from "./accounts/accountPresentation";
import { pinnedProviderInstances } from "./accounts/useProviderInstances";
import { providerActionMessage } from "./providerErrorMessage";
import { linkHost, signInAccountMismatch, type SignInStage } from "./signInSheetParts";
import { isCheckingCode, SignInSheetFrame, STATUS_POLL_MS, useSuccessHold, verifyingHintFor, type SignInMachine, type SignInSheetView } from "./signInSheetFrame";
import { useSettingsMachineScope } from "../SettingsMachineScope";

type AccountPhase = "form" | "signing" | "success" | "failed";

function accountStartFailure(err: unknown): string {
  // A pinned machine on an ADE from before in-app sign-in has no login actions.
  if (isUnsupportedAdeActionError(err)) {
    return "That machine runs an older ADE that cannot sign in from Settings. Update ADE there, then sign in to this account again.";
  }
  return providerActionMessage(err, "That sign-in could not be started.");
}

type AccountSignInSheetProps = SignInMachine & {
  provider: ProviderInstanceProvider;
  providerLabel: string;
  /** Present when reopening sign-in for an account that already exists. */
  existingInstance?: ProviderInstance | null;
  /** The login a new account is meant for, e.g. one being added back. */
  expectedEmail?: string;
  /** Called on every close. `changed` is true once anything was written; `signedIn` only after a sign-in that worked. */
  onClose: (changed: boolean, signedIn?: boolean) => void;
};

/**
 * Add a login for one provider, or sign an existing one in again. The host
 * runs the provider's own login for THIS account's config home in a private
 * PTY (`provider_instances.loginStart`) and reports the link, a device code,
 * and whether it waits for a pasted code. The outcome is read, not assumed:
 * the host verifies the account's saved login when the CLI exits, and the
 * sheet polls that status.
 */
function AccountSignInSheet({
  provider,
  providerLabel,
  existingInstance,
  expectedEmail,
  onClose,
  pin,
  isThisMachine,
  machineName,
}: AccountSignInSheetProps) {
  const resuming = Boolean(existingInstance);
  const [phase, setPhase] = useState<AccountPhase>(resuming ? "signing" : "form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [login, setLogin] = useState<ProviderLoginStatus | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [signedInAs, setSignedInAs] = useState<string | null>(null);

  const instanceIdRef = useRef<string | null>(existingInstance?.id ?? null);
  const loginRef = useRef<ProviderLoginStatus | null>(null);
  /** Orders overlapping starts: only the newest one may apply its reply. */
  const startSeqRef = useRef(0);
  const changedRef = useRef(false);
  const signedInRef = useRef(false);
  const closedRef = useRef(false);
  const aliveRef = useRef(true);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // One bridge per machine, keyed on the machine (a rebuilt pin keeps its key),
  // so the poll and success effects do not restart on every parent render.
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const api = useMemo(() => pinnedProviderInstances(pinRef.current), [pinKey]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const applyLogin = useCallback((next: ProviderLoginStatus) => {
    loginRef.current = next;
    if (!aliveRef.current) {
      // Closed while the start was in flight: the unmount cleanup had no
      // login to stop yet, so stop this one now.
      if (isProviderLoginLive(next)) void api?.loginCancel?.({ loginId: next.loginId }).catch(() => undefined);
      return;
    }
    setLogin(next);
    if (next.state === "succeeded") {
      changedRef.current = true;
      signedInRef.current = true;
      setSignedInAs(next.email ?? null);
      setPhase("success");
    } else if (next.state === "failed") {
      changedRef.current = true;
      setPhase("failed");
    }
  }, [api]);

  // A sign-in left running behind a closed sheet would hold the CLI open on
  // the account's machine until its timeout. Stop it.
  useEffect(() => () => {
    const open = loginRef.current;
    if (open && isProviderLoginLive(open)) void api?.loginCancel?.({ loginId: open.loginId }).catch(() => undefined);
  }, [api]);

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onCloseRef.current(changedRef.current, signedInRef.current);
  }, []);

  const startLogin = useCallback(async (id: string) => {
    if (!api?.loginStart) throw new Error("This ADE host cannot run a sign-in from Settings. Update ADE on that machine.");
    const seq = ++startSeqRef.current;
    // A second start (a quick "Try again") supersedes the first; stop the one
    // still running so its CLI does not linger.
    const previous = loginRef.current;
    if (previous && isProviderLoginLive(previous)) {
      void api.loginCancel?.({ loginId: previous.loginId }).catch(() => undefined);
    }
    setError(null);
    setCode("");
    setLogin(null);
    loginRef.current = null;
    setSignedInAs(null);
    setPhase("signing");
    // On another machine, or in the hosted web client, the browser is not on
    // the account's computer, so a sign-in that returns to its localhost fails.
    const browserOnHost = isThisMachine && !isWebClientMode();
    const next = await api.loginStart({ id, ...(browserOnHost ? {} : { deviceAuth: true }) });
    // A later start replaced this reply; its status is the real one.
    if (seq !== startSeqRef.current) {
      if (isProviderLoginLive(next)) void api.loginCancel?.({ loginId: next.loginId }).catch(() => undefined);
      return;
    }
    applyLogin(next);
  }, [api, applyLogin, isThisMachine]);

  /** Start (or restart) a sign-in for an account that exists; a failure ends the sheet's attempt. */
  const runLogin = useCallback((id: string) => {
    void startLogin(id).catch((err) => {
      if (!aliveRef.current) return;
      setError(accountStartFailure(err));
      setPhase("failed");
    });
  }, [startLogin]);

  // Poll the host's sign-in while it runs.
  useEffect(() => {
    if (!api?.loginStatus || !login || !isProviderLoginLive(login)) return;
    const loginId = login.loginId;
    const timer = window.setTimeout(() => {
      void api.loginStatus({ loginId })
        .then(applyLogin)
        .catch((err) => {
          if (!aliveRef.current) return;
          setError(providerActionMessage(err, "Lost track of that sign-in."));
          setPhase("failed");
        });
    }, STATUS_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [api, applyLogin, login]);

  // The account list reads the new login on close; the usage poll is asked
  // for its first reading by naming the account. Once: the refresh publishes
  // a new usage snapshot, and that re-renders the parent.
  const refreshedRef = useRef(false);
  useEffect(() => {
    if (phase !== "success") return;
    const id = instanceIdRef.current;
    if (api && id && !refreshedRef.current) {
      refreshedRef.current = true;
      void api.refresh({ provider, instanceId: id }).catch(() => undefined);
    }
  }, [api, phase, provider]);

  // Create the account, then start its sign-in.
  const startCreate = useCallback(async () => {
    if (!api) {
      setError("Provider accounts are not available in this window.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // No name: the account is shown by the email it signs in with. A host
      // older than nameless accounts still asks for one; give it the provider's.
      const created = await api.create({ provider }).catch((err: unknown) => {
        if (!providerActionMessage(err, "").includes("needs a label")) throw err;
        return api.create({ provider, label: providerLabel });
      });
      changedRef.current = true;
      instanceIdRef.current = created.instance.id;
      if (!aliveRef.current) return;
      await startLogin(created.instance.id);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(accountStartFailure(err));
      setPhase(instanceIdRef.current ? "failed" : "form");
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [api, provider, providerLabel, startLogin]);

  // Reopening sign-in for an account that already exists.
  const startedRef = useRef(false);
  useEffect(() => {
    if (!resuming || startedRef.current || !instanceIdRef.current) return;
    startedRef.current = true;
    runLogin(instanceIdRef.current);
  }, [resuming, runLogin]);

  const tryAgain = useCallback(() => {
    const id = instanceIdRef.current;
    if (id) runLogin(id);
  }, [runLogin]);

  const submitCode = useCallback(async () => {
    const current = loginRef.current;
    if (!api?.loginSubmitCode || !current || !code.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      applyLogin(await api.loginSubmitCode({ loginId: current.loginId, code: code.trim() }));
      setCode("");
    } catch (err) {
      if (aliveRef.current) setError(providerActionMessage(err, "That code was not accepted."));
    } finally {
      if (aliveRef.current) setSubmitting(false);
    }
  }, [api, applyLogin, code]);

  // An account is called by its email. One that has never signed in has none
  // yet: the machine's own login is just "the provider" to the person signing
  // in (first run, the provider card), any other is "this account".
  const existingName = existingInstance
    ? existingInstance.account?.email?.trim() || (existingInstance.isDefault ? providerLabel : null)
    : null;
  const accountName = existingName ?? expectedEmail ?? "this account";
  // The account ADE knew before: the one being signed in again, or the one a
  // new account is meant for.
  const expectedAccount = existingInstance?.account?.email?.trim() || expectedEmail?.trim() || null;
  const signedInEmail = signedInAs?.trim() || null;
  const wrongAccount = phase === "success" && signInAccountMismatch(expectedAccount, signedInEmail);
  const title = resuming ? `Sign in to ${existingName ?? providerLabel}` : `Add a ${providerLabel} account`;
  const host = linkHost(login?.url ?? null);

  const stage: SignInStage = phase === "form"
    ? "form"
    : phase === "success"
      ? wrongAccount ? "mismatch" : "done"
      : phase === "failed"
        ? "failed"
        : !login
          ? "starting"
          : login.state === "verifying" || isCheckingCode(login) ? "verifying" : "waiting";
  useSuccessHold(stage, close);

  const view: SignInSheetView = {
    stage,
    verifyingHint: verifyingHintFor(login),
    url: login?.url ?? null,
    deviceCode: login?.deviceCode ?? null,
    codeHint: login?.deviceCode
      ? "On the page, choose the account you want, then enter the code."
      : `${host ?? providerLabel} opens in your browser. Choose the account you want, then approve.`,
    paste: login?.awaitingCode
      ? {
          label: "Did the page show a code? Paste it here.",
          value: code,
          onChange: setCode,
          onSubmit: () => void submitCode(),
          submitting,
        }
      : null,
    output: login?.output ?? "",
    expectedAccount,
    account: signedInEmail,
    error: phase === "failed" && !login ? null : error,
    failure: phase === "failed"
      ? {
          title: !login && error ? "The sign-in could not start." : login?.state === "cancelled" ? "The sign-in was stopped." : "Sign-in did not complete.",
          detail: !login && error
            ? error
            : login?.message ?? `ADE found no working login for ${accountName}. ${providerLabel} saves it only after you approve in the browser.`,
          stopped: login?.state === "cancelled",
          extra: existingInstance ? (
            <span className="ade-sis-hint">
              Now: {[existingInstance.account?.email, accountIdentityLine(existingInstance)].filter(Boolean).join(" · ")}
            </span>
          ) : null,
        }
      : null,
    form: (
      <Banner
        layout="inline"
        model={{
          id: "account-sign-in-hint",
          tone: "neutral",
          icon: <ShieldCheck size={15} />,
          title: "Your other accounts stay signed in",
          detail: `Next, ${providerLabel} opens its sign-in page in your browser. Pick ${expectedEmail ?? "the account you want"} there before you approve. The account shows as its email once signed in, and its login is saved for it only.`,
        }}
      />
    ),
  };

  return (
    <SignInSheetFrame
      providerId={provider}
      providerLabel={providerLabel}
      title={title}
      machine={{ pin, isThisMachine, machineName }}
      view={view}
      onClose={close}
      onTryAgain={tryAgain}
      onKeep={close}
      continueAction={{ label: busy ? "Starting…" : "Continue to sign-in", onClick: () => void startCreate(), disabled: busy }}
      closeLabel="Close add account"
    />
  );
}

/** What the account sheet opens on: an existing account, or a new one, optionally meant for one login. */
export type AccountSignInTarget = { existing: ProviderInstance | null; email?: string };

/**
 * Hosts the account sheet for one provider on the Settings page's machine
 * (`useSettingsMachineScope`; first setup provides the same scope): `open`
 * shows it, `element` goes anywhere in the tree. `onChanged` runs after a
 * close that wrote something.
 */
export function useAccountSignInSheet({
  provider,
  providerLabel,
  onChanged,
}: {
  provider: ProviderInstanceProvider;
  providerLabel: string;
  /** `signedIn` is true only when the sign-in succeeded. */
  onChanged: (signedIn: boolean) => void;
}): { open: (target: AccountSignInTarget) => void; element: React.ReactNode } {
  const { pin, isThisMachine, machineName } = useSettingsMachineScope();
  const [target, setTarget] = useState<AccountSignInTarget | null>(null);
  const element = target ? (
    <AccountSignInSheet
      // A new target is a new sheet, never the old one's state.
      key={target.existing?.id ?? `new:${target.email ?? ""}`}
      provider={provider}
      providerLabel={providerLabel}
      existingInstance={target.existing}
      expectedEmail={target.email}
      pin={pin}
      isThisMachine={isThisMachine}
      machineName={machineName}
      onClose={(changed, signedIn) => {
        setTarget(null);
        if (changed) onChanged(signedIn === true);
      }}
    />
  ) : null;
  return { open: setTarget, element };
}
