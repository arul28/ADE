/**
 * Sign in to an agent CLI ADE runs from its own copy (Grok, Devin, Muse,
 * GitHub Copilot, Droid, Kimi) without a terminal on screen, the way the
 * Claude Code and Codex account sheet does.
 *
 * The machine that owns the CLI runs its own login in a private PTY
 * (`ai.cliLoginStart`, routed by `pin`) and reports what it printed: the
 * sign-in link, a device code to confirm, and whether it is asking for a code
 * pasted from the browser. The sheet shows those, polls the status, and closes
 * once that machine reads the provider's saved login back.
 *
 * Settings passes its machine scope's pin; first-run setup passes null (it
 * runs on the machine it sets up).
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowSquareOut, Check, CheckCircle, CircleNotch, Copy, SignIn } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../../lanes/laneDesignTokens";
import { Dialog, type DialogAction } from "../../ui/dialog";
import { Banner } from "../../ui/notice/Banner";
import { ProviderLogo } from "../../shared/ProviderLogos";
import { isImeComposing } from "../../../lib/imeComposition";
import { isWebClientMode } from "../../../lib/webClientMode";
import { isUnsupportedAdeActionError } from "../../../../shared/codedError";
import type { OpenProjectBinding } from "../../../../shared/types";
import {
  isProviderLoginLive,
  type AgentCliLoginProvider,
  type AgentCliLoginStatus,
  type KimiLoginRegion,
} from "../../../../shared/types";
import { OutputDisclosure } from "./accounts/AddProviderAccountSheet";
import { providerActionMessage } from "./providerErrorMessage";
import { useSettingsMachineScope } from "../SettingsMachineScope";
import type { ProvidersViewContext } from "./types";

const SUCCESS_HOLD_MS = 1_600;
const STATUS_POLL_MS = 1_000;

/** The `ProviderLogo` family for each CLI. */
const LOGO_FAMILY: Record<AgentCliLoginProvider, string> = {
  grok: "grok",
  devin: "devin",
  muse: "muse",
  copilot: "github-copilot",
  droid: "droid",
  kimi: "kimi",
};

const KIMI_REGIONS: ReadonlyArray<{ id: KimiLoginRegion; label: string; hint: string }> = [
  { id: "global", label: "kimi.ai", hint: "International accounts" },
  { id: "mainland-cn", label: "kimi.com", hint: "Mainland China accounts" },
];

type Phase = "form" | "signing" | "success" | "failed";

function startFailureMessage(err: unknown): string {
  if (isUnsupportedAdeActionError(err)) {
    return "That machine runs an older ADE that cannot sign in here. Update ADE there, or sign in from its Settings.";
  }
  return providerActionMessage(err, "That sign-in could not be started.");
}

function linkHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Whether this host can run the in-app sign-in (an older one has no `cliLogin*`). */
export function agentCliSignInSupported(): boolean {
  return typeof window.ade?.ai?.cliLoginStart === "function";
}

export type AgentCliSignInSheetProps = {
  provider: AgentCliLoginProvider;
  providerLabel: string;
  /** The machine that runs the CLI; null for the window's own (first-run setup). */
  pin: OpenProjectBinding | null;
  /** True when that machine is this computer, so its browser is the one in front of the user. */
  isThisMachine: boolean;
  /** Called on every close. `changed` is true once a sign-in ended (either way). */
  onClose: (changed: boolean) => void;
};

export function AgentCliSignInSheet({ provider, providerLabel, pin, isThisMachine, onClose }: AgentCliSignInSheetProps) {
  const needsRegion = provider === "kimi";
  const [phase, setPhase] = useState<Phase>(needsRegion ? "form" : "signing");
  const [region, setRegion] = useState<KimiLoginRegion>("global");
  const [login, setLogin] = useState<AgentCliLoginStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  /** A pasted code went in: the CLI is checking it, so the sheet says so instead of "open your browser". */
  const [codeSent, setCodeSent] = useState(false);

  const pinRef = useRef(pin);
  pinRef.current = pin;
  const loginRef = useRef<AgentCliLoginStatus | null>(null);
  const startSeqRef = useRef(0);
  const changedRef = useRef(false);
  const closedRef = useRef(false);
  const aliveRef = useRef(true);
  const openedRef = useRef<string | null>(null);
  const codeInputRef = useRef<HTMLInputElement | null>(null);
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
    onCloseRef.current(changedRef.current);
  }, []);

  const applyLogin = useCallback((next: AgentCliLoginStatus) => {
    loginRef.current = next;
    if (!aliveRef.current) {
      cancelOnHost(next);
      return;
    }
    setLogin(next);
    // A device flow's page can be opened anywhere: open it in the browser in
    // front of the user, unless the CLI already opens one on this computer.
    if (next.url && next.state === "running" && openedRef.current !== next.loginId) {
      const cliOpensItHere = next.opensBrowser && isThisMachine && !isWebClientMode();
      openedRef.current = next.loginId;
      if (!cliOpensItHere) void window.ade?.app?.openExternal?.(next.url);
    }
    if (next.state === "succeeded") {
      changedRef.current = true;
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
    setError(null);
    setCode("");
    setCodeSent(false);
    setShowOutput(false);
    setLogin(null);
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
      setError(startFailureMessage(err));
      setPhase("failed");
    }
  }, [applyLogin, cancelOnHost, needsRegion, provider, region]);

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
        .then(applyLogin)
        .catch((err) => {
          if (!aliveRef.current) return;
          setError(providerActionMessage(err, "Lost track of that sign-in."));
          setPhase("failed");
        });
    }, STATUS_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [applyLogin, login]);

  useEffect(() => {
    if (phase !== "success") return;
    const timer = window.setTimeout(close, SUCCESS_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [close, phase]);

  useEffect(() => {
    if (login?.awaitingCode) codeInputRef.current?.focus();
  }, [login?.awaitingCode]);

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

  const copyLink = useCallback(() => {
    const url = loginRef.current?.url;
    if (!url) return;
    void navigator.clipboard?.writeText(url).then(() => {
      if (!aliveRef.current) return;
      setCopied(true);
      window.setTimeout(() => {
        if (aliveRef.current) setCopied(false);
      }, 1_500);
    }).catch(() => undefined);
  }, []);

  // After a pasted code the CLI checks it; the link and the field are done with.
  const verifying = login?.state === "verifying" || (codeSent && login?.state === "running" && !login.awaitingCode);
  const host = linkHost(login?.url ?? null);
  const headline = !login
    ? "Starting sign-in…"
    : login.downloading
      ? `Getting ${providerLabel} ready…`
      : verifying
        ? codeSent ? "Checking the code…" : "Checking the new login…"
        : login.awaitingCode
          ? "Approve in your browser, then paste the code"
          : login.url
            ? "Finish signing in with your browser"
            : `Starting ${providerLabel}…`;
  const detail = !login
    ? `ADE is running ${providerLabel}'s own sign-in.`
    : login.downloading
      ? login.downloading
      : verifying
        ? codeSent ? `${providerLabel} is checking the code you pasted.` : `ADE is reading ${providerLabel}'s saved login.`
        : login.deviceCode
          ? `On ${host ?? "the sign-in page"}, check that it shows this code, then approve:`
          : login.awaitingCode
            ? `${host ?? "The sign-in page"} shows a code once you approve. Paste it below.`
            : login.url
              ? `${host ?? providerLabel} should be open in your browser. Sign in and approve.`
              : "Waiting for its sign-in link…";

  const footerStart = phase === "signing" ? (
    <span role="status" style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
      <CircleNotch size={13} className="animate-spin motion-reduce:animate-none" />
      {verifying ? "Checking the saved login…" : "Waiting for you to approve in the browser"}
    </span>
  ) : undefined;

  const actions: DialogAction[] = phase === "form"
    ? [{ label: "Continue to sign-in", onClick: () => void start(), variant: "solid" }]
    : phase === "signing"
      ? [{ label: "Cancel", onClick: close, variant: "secondary" }]
      : phase === "failed"
        ? [
            { label: "Close", onClick: close, variant: "secondary" },
            { label: "Try again", onClick: () => void start(), variant: "solid" },
          ]
        : [];

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={<>Sign in to {providerLabel}</>}
      closeLabel={`Close ${providerLabel} sign-in`}
      width={520}
      maxHeight="82vh"
      bodyPadding={false}
      scrollBody
      bodyStyle={{ display: "flex", flexDirection: "column", marginTop: 6 }}
      tone="accent"
      footerStart={footerStart}
      actions={actions}
    >
      {error ? (
        <Banner layout="inline" style={{ margin: "12px 20px 0" }} model={{ id: "agent-cli-sign-in-error", tone: "error", title: error }} />
      ) : null}

      {phase === "form" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "16px 20px 8px" }}>
          <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>Which Kimi do you sign in to?</span>
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
      ) : null}

      {phase === "signing" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "16px 20px 8px" }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 10,
              padding: "22px 20px 18px",
              borderRadius: 12,
              border: `1px solid ${COLORS.borderMuted}`,
              background: COLORS.recessedBg,
              textAlign: "center",
            }}
          >
            <span
              aria-hidden
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 44,
                height: 44,
                borderRadius: 12,
                background: COLORS.cardBg,
                border: `1px solid ${COLORS.outlineBorder}`,
              }}
            >
              <ProviderLogo family={LOGO_FAMILY[provider]} size={22} />
            </span>
            <span style={{ fontSize: 14, fontWeight: 500, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>{headline}</span>
            <span style={{ maxWidth: 400, fontSize: 12, lineHeight: 1.5, fontFamily: SANS_FONT, color: COLORS.textMuted }}>{detail}</span>
            {login?.deviceCode && !verifying ? (
              <span
                aria-label="One-time sign-in code"
                style={{
                  padding: "6px 14px",
                  fontSize: 18,
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  fontFamily: MONO_FONT,
                  color: COLORS.textPrimary,
                  background: COLORS.recessedBg,
                  border: `1px solid ${COLORS.outlineBorder}`,
                  borderRadius: 8,
                  userSelect: "all",
                }}
              >
                {login.deviceCode}
              </span>
            ) : null}
            {login?.url && !verifying ? (
              <span style={{ display: "inline-flex", gap: 8, marginTop: 4 }}>
                <button
                  type="button"
                  onClick={() => void window.ade?.app?.openExternal?.(login.url!)}
                  style={outlineButton({ height: 28, padding: "0 12px", fontSize: 12 })}
                >
                  <ArrowSquareOut size={13} /> Open sign-in page
                </button>
                <button type="button" onClick={copyLink} style={outlineButton({ height: 28, padding: "0 12px", fontSize: 12 })}>
                  {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy link"}
                </button>
              </span>
            ) : null}
          </div>

          {login?.awaitingCode ? (
            <div style={{ display: "flex", gap: 8 }}>
              <input
                ref={codeInputRef}
                aria-label="Sign-in code"
                value={code}
                placeholder="Paste the code here"
                onChange={(event) => setCode(event.target.value)}
                onKeyDown={(event) => {
                  if (isImeComposing(event)) return;
                  if (event.key === "Enter") void submitCode();
                }}
                style={{
                  flex: 1,
                  height: 34,
                  padding: "0 10px",
                  fontSize: 12,
                  fontFamily: MONO_FONT,
                  color: COLORS.textPrimary,
                  background: COLORS.cardBg,
                  border: `1px solid ${COLORS.outlineBorder}`,
                  borderRadius: 8,
                  outline: "none",
                }}
              />
              <button
                type="button"
                onClick={() => void submitCode()}
                disabled={submitting || !code.trim()}
                style={{ ...outlineButton({ height: 34, padding: "0 14px", fontSize: 12 }), opacity: submitting || !code.trim() ? 0.5 : 1 }}
              >
                {submitting ? "Sending…" : "Submit"}
              </button>
            </div>
          ) : null}

          <OutputDisclosure output={login?.output ?? ""} open={showOutput} onToggle={() => setShowOutput((open) => !open)} />
        </div>
      ) : null}

      {phase === "success" ? (
        <div role="status" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 180, padding: "24px 20px", textAlign: "center" }}>
          <CheckCircle size={40} weight="fill" style={{ color: COLORS.success }} />
          <span style={{ fontSize: 14, fontWeight: 500, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
            {providerLabel} is signed in{login?.email ? ` as ${login.email}` : ""}
          </span>
        </div>
      ) : null}

      {phase === "failed" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "16px 20px 8px" }}>
          {login ? (
            <Banner
              layout="inline"
              model={{
                id: "agent-cli-sign-in-unconfirmed",
                tone: "warning",
                title: login.state === "cancelled" ? "The sign-in was stopped." : "Sign-in did not complete.",
                detail: login.message ?? `ADE found no working ${providerLabel} login. It saves one only after you approve in the browser.`,
              }}
            />
          ) : null}
          <OutputDisclosure output={login?.output ?? ""} open={showOutput} onToggle={() => setShowOutput((open) => !open)} />
        </div>
      ) : null}
    </Dialog>
  );
}

/**
 * Hosts the sheet for one CLI: `open()` shows it, `element` goes anywhere in
 * the tree. `onChanged` runs after a close that ended a sign-in.
 */
export function useAgentCliSignInSheet({
  provider,
  providerLabel,
  pin,
  isThisMachine,
  onChanged,
}: Omit<AgentCliSignInSheetProps, "onClose"> & { onChanged: () => void }): { open: () => void; element: React.ReactNode } {
  const [openCount, setOpenCount] = useState(0);
  const [shown, setShown] = useState(false);
  const open = useCallback(() => {
    setOpenCount((count) => count + 1);
    setShown(true);
  }, []);
  const element = shown ? (
    <AgentCliSignInSheet
      key={openCount}
      provider={provider}
      providerLabel={providerLabel}
      pin={pin}
      isThisMachine={isThisMachine}
      onClose={(changed) => {
        setShown(false);
        if (changed) onChanged();
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
}: {
  ctx: ProvidersViewContext;
  provider: AgentCliLoginProvider;
  providerLabel: string;
  fallback: React.ReactNode;
  /** Already signed in: a quieter "Sign in again", to switch accounts or renew the login. */
  again?: boolean;
}) {
  const { pin, isThisMachine, machineName } = useSettingsMachineScope();
  const refreshStatus = ctx.actions.refreshStatus;
  const sheet = useAgentCliSignInSheet({
    provider,
    providerLabel,
    pin,
    isThisMachine,
    onChanged: () => void refreshStatus({ force: true, silent: true }),
  });
  if (!agentCliSignInSupported()) return <>{fallback}</>;
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
          : `Runs ${providerLabel}'s own sign-in with ADE's copy on ${where} (downloading it first if needed). You approve in the browser; the login is ${providerLabel}'s, saved where it always saves it.`}
      </div>
      {sheet.element}
    </div>
  );
}
