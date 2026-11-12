/**
 * The sheet for the agent CLIs ADE signs in itself (Grok, Devin, Muse,
 * Copilot, Droid, Kimi): the CLI's own login run by ADE on the sheet's
 * machine (`ai.cliLogin*`), drawn in the shared sign-in frame.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { SignIn } from "@phosphor-icons/react";
import { COLORS, SANS_FONT, outlineButton } from "../../lanes/laneDesignTokens";
import { isWebClientMode } from "../../../lib/webClientMode";
import { isUnsupportedAdeActionError } from "../../../../shared/codedError";
import {
  isProviderLoginLive,
  type AgentCliLoginProvider,
  type AgentCliLoginStatus,
  type KimiLoginRegion,
} from "../../../../shared/types";
import { providerActionMessage } from "./providerErrorMessage";
import { linkHost, signInAccountMismatch, type SignInStage } from "./signInSheetParts";
import { SignInSheetFrame, STATUS_POLL_MS, useSuccessHold, type SignInMachine, type SignInSheetView } from "./signInSheetFrame";
import { useSettingsMachineScope } from "../SettingsMachineScope";
import type { ProvidersViewContext } from "./types";

/** Status reads that may fail in a row (a relay hiccup) before the CLI sheet gives up. */
const STATUS_READ_RETRIES = 3;

/** The `ProviderLogo` / brand id for each CLI. */
const CLI_BRAND: Record<AgentCliLoginProvider, string> = {
  grok: "grok",
  devin: "devin",
  muse: "muse",
  copilot: "copilot",
  droid: "droid",
  kimi: "kimi",
};

const KIMI_REGIONS: ReadonlyArray<{ id: KimiLoginRegion; label: string; hint: string }> = [
  { id: "global", label: "kimi.ai", hint: "International accounts" },
  { id: "mainland-cn", label: "kimi.com", hint: "Mainland China accounts" },
];

/** Whether this host can run the in-app CLI sign-in (an older one has no `cliLogin*`). */
export function agentCliSignInSupported(): boolean {
  return typeof window.ade?.ai?.cliLoginStart === "function";
}

type CliPhase = "form" | "signing" | "success" | "failed";

function cliStartFailure(err: unknown): string {
  if (isUnsupportedAdeActionError(err)) {
    return "That machine runs an older ADE that cannot sign in here. Update ADE there, or sign in from its Settings.";
  }
  return providerActionMessage(err, "That sign-in could not be started.");
}

type CliSignInSheetProps = SignInMachine & {
  provider: AgentCliLoginProvider;
  providerLabel: string;
  /** The account the machine named before this sign-in, when it names one. */
  expectedAccount?: string | null;
  /** Called on every close. `changed` once a sign-in ended (either way); `signedIn` only when it worked. */
  onClose: (changed: boolean, signedIn?: boolean) => void;
};

/**
 * Sign in to an agent CLI ADE runs from its own copy. The machine that owns
 * the CLI runs its login in a private PTY (`ai.cliLoginStart`, routed by
 * `pin`) and reports the link, a device code, and whether it waits for a
 * pasted code. The sheet polls the status and closes once that machine reads
 * the provider's saved login back.
 */
export function CliSignInSheet({ provider, providerLabel, pin, isThisMachine, machineName, expectedAccount = null, onClose }: CliSignInSheetProps) {
  const needsRegion = provider === "kimi";
  const [phase, setPhase] = useState<CliPhase>(needsRegion ? "form" : "signing");
  const [region, setRegion] = useState<KimiLoginRegion>("global");
  const [login, setLogin] = useState<AgentCliLoginStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  /** A pasted code went in: the CLI is checking it. */
  const [codeSent, setCodeSent] = useState(false);
  /** Status reads failed in a row; a new one is tried until STATUS_READ_RETRIES. */
  const [failedReads, setFailedReads] = useState(0);

  /** The machine the current sign-in runs on, fixed when it starts: its polls, code and cancel go there. */
  const pinRef = useRef(pin);
  const loginRef = useRef<AgentCliLoginStatus | null>(null);
  const startSeqRef = useRef(0);
  const changedRef = useRef(false);
  const signedInRef = useRef(false);
  const closedRef = useRef(false);
  const aliveRef = useRef(true);
  const openedRef = useRef<string | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const cancelOnHost = useCallback((target: AgentCliLoginStatus | null) => {
    if (target && isProviderLoginLive(target)) {
      void window.ade?.ai?.cliLoginCancel?.({ loginId: target.loginId }, pinRef.current).catch(() => undefined);
    }
  }, []);

  // A sign-in left running behind a closed sheet would hold the CLI open on
  // its machine until the timeout.
  useEffect(() => () => cancelOnHost(loginRef.current), [cancelOnHost]);

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onCloseRef.current(changedRef.current, signedInRef.current);
  }, []);

  const applyLogin = useCallback((next: AgentCliLoginStatus) => {
    loginRef.current = next;
    if (!aliveRef.current) {
      cancelOnHost(next);
      return;
    }
    setLogin(next);
    // A device flow's page can be opened anywhere: open it in the browser in
    // front of the person, unless the CLI already opens one on this computer.
    if (next.url && next.state === "running" && openedRef.current !== next.loginId) {
      const cliOpensItHere = next.opensBrowser && isThisMachine && !isWebClientMode();
      openedRef.current = next.loginId;
      if (!cliOpensItHere) void window.ade?.app?.openExternal?.(next.url);
    }
    if (next.state === "succeeded") {
      changedRef.current = true;
      signedInRef.current = true;
      setPhase("success");
    } else if (next.state === "failed" || next.state === "cancelled") {
      changedRef.current = true;
      setPhase("failed");
    }
  }, [cancelOnHost, isThisMachine]);

  const start = useCallback(async () => {
    const begin = window.ade?.ai?.cliLoginStart;
    if (!begin) {
      setError("This window cannot run that sign-in. Update ADE, or sign in from a terminal.");
      setPhase("failed");
      return;
    }
    const seq = ++startSeqRef.current;
    cancelOnHost(loginRef.current);
    pinRef.current = pin;
    setError(null);
    setCode("");
    setCodeSent(false);
    setLogin(null);
    setFailedReads(0);
    loginRef.current = null;
    setPhase("signing");
    try {
      const next = await begin({ provider, ...(needsRegion ? { kimiRegion: region } : {}) }, pinRef.current);
      if (seq !== startSeqRef.current) {
        cancelOnHost(next);
        return;
      }
      applyLogin(next);
    } catch (err) {
      if (!aliveRef.current || seq !== startSeqRef.current) return;
      setError(cliStartFailure(err));
      setPhase("failed");
    }
  }, [applyLogin, cancelOnHost, needsRegion, pin, provider, region]);

  // Everything but Kimi (which asks for its region first) starts on open.
  const startedRef = useRef(false);
  useEffect(() => {
    if (needsRegion || startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [needsRegion, start]);

  useEffect(() => {
    if (!login || !isProviderLoginLive(login)) return;
    const read = window.ade?.ai?.cliLoginStatus;
    if (!read) return;
    const loginId = login.loginId;
    const timer = window.setTimeout(() => {
      void read({ loginId }, pinRef.current)
        .then((next) => {
          setFailedReads(0);
          applyLogin(next);
        })
        .catch((err) => {
          if (!aliveRef.current) return;
          // The machine forgot the sign-in: no retry brings it back.
          const gone = err instanceof Error && /no longer running/i.test(err.message);
          if (!gone && failedReads + 1 < STATUS_READ_RETRIES) {
            setFailedReads((count) => count + 1);
            return;
          }
          setError(providerActionMessage(err, "Lost track of that sign-in."));
          setPhase("failed");
        });
    }, STATUS_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [applyLogin, failedReads, login]);

  const submitCode = useCallback(async () => {
    const current = loginRef.current;
    const send = window.ade?.ai?.cliLoginSubmitCode;
    if (!send || !current || !code.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      applyLogin(await send({ loginId: current.loginId, code: code.trim() }, pinRef.current));
      setCode("");
      setCodeSent(true);
    } catch (err) {
      if (aliveRef.current) setError(providerActionMessage(err, "That code was not accepted."));
    } finally {
      if (aliveRef.current) setSubmitting(false);
    }
  }, [applyLogin, code]);

  // After a pasted code the CLI checks it.
  const verifying = login?.state === "verifying" || (login?.state === "running" && (login.checkingCode === true || (codeSent && !login.awaitingCode)));
  const host = linkHost(login?.url ?? null);
  const signedInAs = login?.email?.trim() || null;
  const wrongAccount = phase === "success" && signInAccountMismatch(expectedAccount, signedInAs);
  const stage: SignInStage = phase === "form"
    ? "form"
    : phase === "success"
      ? wrongAccount ? "mismatch" : "done"
      : phase === "failed"
        ? "failed"
        : verifying
          ? "verifying"
          : !login || login.downloading || (!login.url && !login.awaitingCode && !login.deviceCode)
            ? "starting"
            : "waiting";
  useSuccessHold(stage, close);

  const view: SignInSheetView = {
    stage,
    startHint: !login
      ? null
      : login.downloading
        ? login.downloading
        : `Waiting for ${providerLabel}'s sign-in link…`,
    verifyingHint: login?.checkingCode ? "Checking the code…" : null,
    url: login?.url ?? null,
    deviceCode: login?.deviceCode ?? null,
    codeHint: login?.deviceCode
      ? `On ${host ?? "the sign-in page"}, check that it shows this code, then approve.`
      : login?.awaitingCode
        ? `${host ?? "The sign-in page"} shows a code once you approve. Paste it below.`
        : `${host ?? providerLabel} opens in your browser. Sign in, then approve.`,
    paste: login?.awaitingCode
      ? {
          label: "Paste the code from the sign-in page",
          value: code,
          onChange: setCode,
          onSubmit: () => void submitCode(),
          submitting,
        }
      : null,
    output: login?.output ?? "",
    expectedAccount,
    account: signedInAs,
    error: phase === "failed" ? null : error,
    failure: phase === "failed"
      ? !login
        ? { title: "The sign-in could not start.", detail: error }
        : {
            title: login.state === "cancelled" ? "The sign-in was stopped." : "Sign-in did not complete.",
            detail: error ?? login.message ?? `ADE found no working ${providerLabel} login. It saves one only after you approve in the browser.`,
            stopped: login.state === "cancelled",
          }
      : null,
    form: needsRegion ? (
      <div className="ade-sis-form">
        <span className="ade-sis-form-label">Which Kimi do you sign in to?</span>
        <div role="radiogroup" aria-label="Kimi region" style={{ display: "flex", gap: 8 }}>
          {KIMI_REGIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="radio"
              aria-checked={region === entry.id}
              onClick={() => setRegion(entry.id)}
              style={{
                ...outlineButton({ height: 48, padding: "0 14px", fontSize: 12 }),
                flex: 1,
                flexDirection: "column",
                alignItems: "flex-start",
                justifyContent: "center",
                gap: 2,
                borderColor: region === entry.id ? COLORS.accent : undefined,
              }}
            >
              <span style={{ fontWeight: 600 }}>{entry.label}</span>
              <span style={{ fontSize: 11, color: COLORS.textMuted }}>{entry.hint}</span>
            </button>
          ))}
        </div>
      </div>
    ) : null,
  };

  return (
    <SignInSheetFrame
      providerId={CLI_BRAND[provider]}
      providerLabel={providerLabel}
      title={`Sign in to ${providerLabel}`}
      machine={{ pin, isThisMachine, machineName }}
      view={view}
      onClose={close}
      onTryAgain={() => void start()}
      onKeep={close}
      continueAction={{ label: "Continue to sign-in", onClick: () => void start() }}
    />
  );
}

/**
 * Hosts the CLI sheet for one provider: `open()` shows it, `element` goes
 * anywhere in the tree. `onChanged` runs after a close that ended a sign-in,
 * with whether it succeeded. `expectedAccount` is read when the sheet opens.
 */
export function useAgentCliSignInSheet({
  provider,
  providerLabel,
  pin,
  isThisMachine,
  machineName,
  expectedAccount = null,
  onChanged,
}: Omit<CliSignInSheetProps, "onClose"> & { onChanged: (signedIn: boolean) => void }): { open: () => void; element: React.ReactNode } {
  const [openCount, setOpenCount] = useState(0);
  const [shown, setShown] = useState<{ expected: string | null } | null>(null);
  const expectedRef = useRef(expectedAccount);
  expectedRef.current = expectedAccount;
  const open = useCallback(() => {
    setOpenCount((count) => count + 1);
    // The account the machine named before this sign-in; the status read
    // after it may already name the new one.
    setShown({ expected: expectedRef.current });
  }, []);
  const element = shown ? (
    <CliSignInSheet
      key={openCount}
      provider={provider}
      providerLabel={providerLabel}
      pin={pin}
      isThisMachine={isThisMachine}
      machineName={machineName}
      expectedAccount={shown.expected}
      onClose={(changed, signedIn) => {
        setShown(null);
        if (changed) onChanged(signedIn === true);
      }}
    />
  ) : null;
  return { open, element };
}

/**
 * Settings' "Sign in to …" for one CLI, on the machine the page shows
 * (`useSettingsMachineScope().pin`). `fallback` is what an older host gets
 * instead (the terminal login or the command to run).
 */
export function SettingsAgentCliSignIn({
  ctx,
  provider,
  providerLabel,
  fallback,
  again = false,
  offered = true,
}: {
  ctx: ProvidersViewContext;
  provider: AgentCliLoginProvider;
  providerLabel: string;
  fallback: React.ReactNode;
  /** Already signed in: a quieter "Sign in again", to switch accounts or renew the login. */
  again?: boolean;
  /**
   * False: no button, only the sheet's host. Rendered in the button's place
   * once a status refresh says signed in, so an open sheet is not unmounted
   * (which cancels its sign-in) before it shows the result.
   */
  offered?: boolean;
}) {
  const { pin, isThisMachine, machineName } = useSettingsMachineScope();
  const refreshStatus = ctx.actions.refreshStatus;
  const sheet = useAgentCliSignInSheet({
    provider,
    providerLabel,
    pin,
    isThisMachine,
    machineName,
    expectedAccount: ctx.status?.providerConnections?.[provider]?.accountEmail ?? null,
    // A sign-in that worked gets the provider's own check (which reads the
    // status again after); one that did not only reads the status again.
    onChanged: (signedIn) => void (signedIn ? ctx.actions.verifySignIn(provider) : refreshStatus({ force: true, silent: true })),
  });
  if (!agentCliSignInSupported()) return <>{fallback}</>;
  if (!offered) return <>{sheet.element}</>;
  const where = isThisMachine ? "this computer" : machineName;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button
        type="button"
        onClick={sheet.open}
        style={outlineButton({ height: 28, padding: "0 12px", fontSize: 12, alignSelf: "flex-start", ...(again ? { opacity: 0.85 } : {}) })}
      >
        <SignIn size={13} /> {again ? "Sign in again" : `Sign in to ${providerLabel}`}
      </button>
      <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
        {again
          ? `Runs ${providerLabel}'s own sign-in again on ${where}, to switch accounts or renew the login. The new login replaces the one it has now.`
          : `Runs ${providerLabel}'s own sign-in with ADE's copy on ${where} (downloading it first if needed). You approve in the browser, and ${providerLabel} keeps the login in its usual place.`}
      </div>
      {sheet.element}
    </div>
  );
}
