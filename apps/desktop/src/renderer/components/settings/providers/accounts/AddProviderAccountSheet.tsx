/**
 * Add a second (or third) login for one provider, or sign an existing one in
 * again.
 *
 * Two beats: name the account, then finish the provider's sign-in in the
 * browser. ADE never drives the vendor's OAuth itself. The host runs the
 * provider's own login command for THIS account's config home in a private PTY
 * (`provider_instances.loginStart`) and reports what it printed: the sign-in
 * link, and whether it is asking for a code pasted from the browser. The sheet
 * shows those as a link and a code field — not a terminal. An embedded
 * terminal drew nothing once the CLI exited, which is a second after the
 * browser approval, and left a session row in Work for every attempt.
 *
 * The outcome is read, not assumed: the host verifies the account's saved login
 * when the CLI exits, and the sheet polls that status (the subscription
 * proxy's sign-in uses the same shape), so it works the same for a Settings
 * page pinned to another machine.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  CaretRight,
  Check,
  CheckCircle,
  CircleNotch,
  Copy,
  ShieldCheck,
} from "@phosphor-icons/react";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../../../lanes/laneDesignTokens";
import { Dialog, type DialogAction } from "../../../ui/dialog";
import { Banner } from "../../../ui/notice/Banner";
import { ProviderLogo } from "../../../shared/ProviderLogos";
import {
  isProviderLoginLive,
  type ProviderInstance,
  type ProviderInstanceProvider,
  type ProviderLoginStatus,
} from "../../../../../shared/types/providerInstances";
import { isUnsupportedAdeActionError } from "../../../../../shared/codedError";
import { AccentSwatchRow } from "./AccentSwatchRow";
import { accountIdentityLine } from "./accountPresentation";
import { providerActionMessage } from "../providerErrorMessage";
import { pinnedProviderInstances } from "./useProviderInstances";
import { useSettingsMachineScope } from "../../SettingsMachineScope";
import { providerColor } from "../../../usage/providerColors";
import { useAppStore } from "../../../../state/appStore";

/** How long the success state stays up before the sheet closes itself. */
const SUCCESS_HOLD_MS = 1_800;
/** Status poll while the host's sign-in runs; the proxy sign-in polls at 1s too. */
const STATUS_POLL_MS = 1_000;

type Phase = "form" | "signing" | "success" | "failed";

export type AddProviderAccountSheetProps = {
  provider: ProviderInstanceProvider;
  providerLabel: string;
  /** Present when reopening sign-in for an account that already exists. */
  existingInstance?: ProviderInstance | null;
  /** A starting label for a new account, e.g. one being added back. */
  initialLabel?: string;
  /** Suggested accent for a brand-new account — the provider's own colour. */
  defaultAccent: string;
  /** Called on every close. `changed` is true once anything was written. */
  onClose: (changed: boolean) => void;
};

/** The sentence for a sign-in that could not start. */
function startFailureMessage(err: unknown): string {
  // A pinned machine on an ADE from before in-app sign-in has no login actions.
  if (isUnsupportedAdeActionError(err)) {
    return "That machine runs an older ADE that cannot sign in from Settings. Update ADE there, then sign in to this account again.";
  }
  return providerActionMessage(err, "That sign-in could not be started.");
}

/** `claude.ai`, `auth.openai.com` — the host a sign-in link points at. */
function linkHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function AddProviderAccountSheet({
  provider,
  providerLabel,
  existingInstance,
  initialLabel,
  defaultAccent,
  onClose,
}: AddProviderAccountSheetProps) {
  // The account, its sign-in and its config home all live on the machine the
  // Settings page is showing.
  const { pin, isThisMachine } = useSettingsMachineScope();
  const resuming = Boolean(existingInstance);
  const [phase, setPhase] = useState<Phase>(resuming ? "signing" : "form");
  const [label, setLabel] = useState(initialLabel ?? "");
  const [accent, setAccent] = useState<string | null>(defaultAccent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [login, setLogin] = useState<ProviderLoginStatus | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  const [signedInAs, setSignedInAs] = useState<string | null>(null);

  const instanceIdRef = useRef<string | null>(existingInstance?.id ?? null);
  const loginRef = useRef<ProviderLoginStatus | null>(null);
  const changedRef = useRef(false);
  const closedRef = useRef(false);
  const aliveRef = useRef(true);
  const labelInputRef = useRef<HTMLInputElement | null>(null);
  const codeInputRef = useRef<HTMLInputElement | null>(null);

  // One bridge per machine, so the poll and success effects do not restart on
  // every parent render.
  const api = useMemo(() => pinnedProviderInstances(pin), [pin]);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

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
      if (isProviderLoginLive(next)) void pinnedProviderInstances(pin)?.loginCancel?.({ loginId: next.loginId }).catch(() => undefined);
      return;
    }
    setLogin(next);
    if (next.state === "succeeded") {
      changedRef.current = true;
      setSignedInAs(next.email ?? null);
      setPhase("success");
    } else if (next.state === "failed") {
      changedRef.current = true;
      setPhase("failed");
    }
  }, [pin]);

  // A sign-in left running behind a closed sheet would hold the CLI open on
  // the account's machine until its timeout. Stop it.
  useEffect(() => () => {
    const open = loginRef.current;
    if (open && isProviderLoginLive(open)) void pinnedProviderInstances(pin)?.loginCancel?.({ loginId: open.loginId }).catch(() => undefined);
  }, [pin]);

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onCloseRef.current(changedRef.current);
  }, []);

  const startLogin = useCallback(async (id: string) => {
    if (!api?.loginStart) throw new Error("This ADE host cannot run a sign-in from Settings. Update ADE on that machine.");
    setError(null);
    setCode("");
    setShowOutput(false);
    setPhase("signing");
    // On another machine the browser is on this computer, not the account's.
    applyLogin(await api.loginStart({ id, ...(isThisMachine ? {} : { deviceAuth: true }) }));
  }, [api, applyLogin, isThisMachine]);

  /** Start (or restart) a sign-in for an account that exists; a failure ends the sheet's attempt. */
  const runLogin = useCallback((id: string) => {
    void startLogin(id).catch((err) => {
      if (!aliveRef.current) return;
      setError(startFailureMessage(err));
      setPhase("failed");
    });
  }, [startLogin]);

  // ── Poll the host's sign-in while it runs ──
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

  // The account list reads the new login on close; the usage poll is asked for
  // its first reading by naming the account.
  const refreshedRef = useRef(false);
  useEffect(() => {
    if (phase !== "success") return;
    const id = instanceIdRef.current;
    // Once: the refresh publishes a new usage snapshot, and that re-renders
    // the parent.
    if (api && id && !refreshedRef.current) {
      refreshedRef.current = true;
      void api.refresh({ provider, instanceId: id }).catch(() => undefined);
    }
    const timer = window.setTimeout(close, SUCCESS_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [api, close, phase, provider]);

  // Focus the code field the moment the CLI asks for one.
  useEffect(() => {
    if (login?.awaitingCode) codeInputRef.current?.focus();
  }, [login?.awaitingCode]);

  // ── Create the account, then start its sign-in ──
  const startCreate = useCallback(async () => {
    if (!api) {
      setError("Provider accounts are not available in this window.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api.create({
        provider,
        label: label.trim(),
        ...(accent ? { accentColor: accent } : {}),
      });
      changedRef.current = true;
      instanceIdRef.current = created.instance.id;
      if (!aliveRef.current) return;
      await startLogin(created.instance.id);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(startFailureMessage(err));
      setPhase(instanceIdRef.current ? "failed" : "form");
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [accent, api, label, provider, startLogin]);

  // ── Reopening sign-in for an account that already exists ──
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

  const accountName = existingInstance?.label ?? (label.trim() || "this account");
  const title = resuming
    ? `Sign in to ${existingInstance?.label ?? providerLabel}`
    : `Add a ${providerLabel} account`;
  const step = phase === "form" ? 0 : phase === "success" ? 2 : 1;
  const host = linkHost(login?.url ?? null);
  const verifying = login?.state === "verifying";

  const footerStart =
    phase === "signing" ? (
      <span
        role="status"
        style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}
      >
        <CircleNotch size={13} className="animate-spin motion-reduce:animate-none" />
        {verifying ? "Checking the saved login…" : !login ? "Starting sign-in…" : "Waiting for you to approve in the browser"}
      </span>
    ) : undefined;
  const actions: DialogAction[] =
    phase === "form"
      ? [{
          label: busy ? "Starting…" : "Continue to sign-in",
          onClick: () => void startCreate(),
          disabled: busy || label.trim().length === 0,
          variant: "solid",
        }]
      : phase === "signing"
        ? [{ label: "Cancel", onClick: close, variant: "secondary" }]
        : phase === "failed"
          ? [
              { label: "Close", onClick: close, variant: "secondary" },
              { label: "Try again", onClick: tryAgain, variant: "solid" },
            ]
          : [];

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
      // JSX title keeps the close button's exact "Close add account" label.
      title={<>{title}</>}
      closeLabel="Close add account"
      width={560}
      maxHeight="82vh"
      initialFocusRef={labelInputRef}
      preventAutoFocus={resuming}
      bodyPadding={false}
      scrollBody
      bodyStyle={{ display: "flex", flexDirection: "column", marginTop: 10 }}
      tone="accent"
      footerStart={footerStart}
      actions={actions}
    >
      {resuming ? null : <SheetSteps current={step} />}

      {error ? (
        <Banner
          layout="inline"
          style={{ margin: "12px 20px 0" }}
          model={{ id: "provider-account-error", tone: "error", title: error }}
        />
      ) : null}

      {phase === "form" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "18px 20px 8px" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={FIELD_LABEL_STYLE}>Name</span>
            <input
              ref={labelInputRef}
              aria-label="Account label"
              value={label}
              autoFocus
              placeholder="Work"
              onChange={(event) => setLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && label.trim() && !busy) void startCreate();
              }}
              style={TEXT_INPUT_STYLE}
            />
            <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim }}>
              Shown in Settings, the usage bar, and on each chat that uses it.
            </span>
          </label>

          <AccentSwatchRow value={accent} onChange={setAccent} />

          <Banner
            layout="inline"
            model={{
              id: "account-sign-in-hint",
              tone: "neutral",
              icon: <ShieldCheck size={15} />,
              title: "Your other accounts stay signed in",
              detail: `Next, ${providerLabel} opens its sign-in page in your browser. Pick the account you want there before you approve. The login is saved for this account only.`,
            }}
          />
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
              <ProviderLogo family={provider} size={22} />
            </span>
            <span style={{ fontSize: 14, fontWeight: 500, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
              {verifying ? "Checking the new login…" : "Finish signing in with your browser"}
            </span>
            <span style={{ maxWidth: 400, fontSize: 12, lineHeight: 1.5, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
              {verifying
                ? `${providerLabel} finished. ADE is reading the saved login for ${accountName}.`
                : login?.deviceCode
                  ? `Open the sign-in page, choose the account for ${accountName}, and enter this code:`
                  : `${host ?? providerLabel} should be open in your browser. Choose the account for ${accountName} and approve.`}
            </span>
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
                <button
                  type="button"
                  onClick={copyLink}
                  style={outlineButton({ height: 28, padding: "0 12px", fontSize: 12 })}
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy link"}
                </button>
              </span>
            ) : null}
          </div>

          {login?.awaitingCode ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={FIELD_LABEL_STYLE}>Browser showed a code instead?</span>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  ref={codeInputRef}
                  aria-label="Sign-in code"
                  value={code}
                  placeholder="Paste the code here"
                  onChange={(event) => setCode(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void submitCode();
                  }}
                  style={{ ...TEXT_INPUT_STYLE, flex: 1, fontFamily: MONO_FONT, fontSize: 12 }}
                />
                <button
                  type="button"
                  onClick={() => void submitCode()}
                  disabled={submitting || !code.trim()}
                  style={{
                    ...outlineButton({ height: 34, padding: "0 14px", fontSize: 12 }),
                    opacity: submitting || !code.trim() ? 0.5 : 1,
                  }}
                >
                  {submitting ? "Sending…" : "Submit"}
                </button>
              </div>
            </div>
          ) : null}

          <OutputDisclosure output={login?.output ?? ""} open={showOutput} onToggle={() => setShowOutput((open) => !open)} />
        </div>
      ) : null}

      {phase === "success" ? (
        <div
          role="status"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            minHeight: 200,
            padding: "24px 20px",
            textAlign: "center",
          }}
        >
          <CheckCircle size={40} weight="fill" style={{ color: COLORS.success }} />
          <span style={{ fontSize: 14, fontWeight: 500, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
            {accountName} is signed in
          </span>
          {signedInAs ? (
            <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted }}>{signedInAs}</span>
          ) : null}
        </div>
      ) : null}

      {phase === "failed" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "16px 20px 8px" }}>
          <Banner
            layout="inline"
            model={{
              id: "provider-account-login-unconfirmed",
              tone: "warning",
              title: login?.state === "cancelled" ? "The sign-in was stopped." : "Sign-in did not complete.",
              detail: login?.message
                ?? `ADE found no working login for ${accountName}. ${providerLabel} saves it only after you approve in the browser.`,
            }}
          />
          {existingInstance ? (
            <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim }}>
              Currently: {accountIdentityLine(existingInstance)}
            </span>
          ) : null}
          <OutputDisclosure output={login?.output ?? ""} open={showOutput} onToggle={() => setShowOutput((open) => !open)} />
        </div>
      ) : null}
    </Dialog>
  );
}

/** The CLI's own words, for when the friendly view is not enough. Closed by default. */
function OutputDisclosure({ output, open, onToggle }: { output: string; open: boolean; onToggle: () => void }) {
  if (!output.trim()) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          alignSelf: "flex-start",
          padding: 0,
          border: "none",
          background: "transparent",
          fontSize: 11,
          fontFamily: SANS_FONT,
          color: COLORS.textDim,
          cursor: "pointer",
        }}
      >
        <CaretRight size={10} style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 120ms ease" }} />
        Sign-in output
      </button>
      {open ? (
        <pre
          style={{
            margin: 0,
            maxHeight: 140,
            overflow: "auto",
            padding: "8px 10px",
            borderRadius: 8,
            border: `1px solid ${COLORS.borderMuted}`,
            background: COLORS.recessedBg,
            fontSize: 11,
            lineHeight: 1.5,
            fontFamily: MONO_FONT,
            color: COLORS.textSecondary,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {output.trim()}
        </pre>
      ) : null}
    </div>
  );
}

const FIELD_LABEL_STYLE: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  fontFamily: SANS_FONT,
  color: COLORS.textSecondary,
};

const TEXT_INPUT_STYLE: React.CSSProperties = {
  height: 34,
  padding: "0 10px",
  fontSize: 13,
  fontFamily: SANS_FONT,
  color: COLORS.textPrimary,
  background: COLORS.cardBg,
  border: `1px solid ${COLORS.outlineBorder}`,
  borderRadius: 8,
  outline: "none",
};

const SHEET_STEPS = ["Name it", "Sign in", "Done"] as const;

/** Where the user is in the add flow: three beats, the current one lit. */
function SheetSteps({ current }: { current: number }) {
  return (
    <ol
      aria-label="Steps"
      style={{ display: "flex", alignItems: "center", gap: 8, margin: 0, padding: "0 20px", listStyle: "none" }}
    >
      {SHEET_STEPS.map((name, index) => {
        const done = index < current;
        const active = index === current;
        const color = active ? COLORS.accent : done ? COLORS.textSecondary : COLORS.textDim;
        return (
          <li
            key={name}
            aria-current={active ? "step" : undefined}
            style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 11, fontFamily: SANS_FONT, color }}
          >
            <span
              aria-hidden
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 18,
                height: 18,
                borderRadius: 999,
                fontSize: 10,
                fontWeight: 600,
                color: active ? "var(--color-bg)" : color,
                background: active ? COLORS.accent : "transparent",
                border: `1px solid ${active ? COLORS.accent : COLORS.outlineBorder}`,
              }}
            >
              {done ? <Check size={10} weight="bold" /> : index + 1}
            </span>
            <span style={{ fontWeight: active ? 500 : 400 }}>{name}</span>
            {index < SHEET_STEPS.length - 1 ? (
              <span aria-hidden style={{ width: 22, height: 1, background: COLORS.borderMuted }} />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** What the sign-in sheet opens on: an existing account, or a new one with an optional starting label. */
export type AccountSignInTarget = { existing: ProviderInstance | null; label?: string };

/**
 * Hosts the sign-in sheet for one provider: `open` shows it, `element` goes
 * anywhere in the tree (outside a folded panel, so the sheet still opens).
 * `onChanged` runs after a close that wrote something.
 */
export function useAccountSignInSheet({
  provider,
  providerLabel,
  onChanged,
}: {
  provider: ProviderInstanceProvider;
  providerLabel: string;
  onChanged: () => void;
}): { open: (target: AccountSignInTarget) => void; element: React.ReactNode } {
  const theme = useAppStore((state) => state.theme);
  const [target, setTarget] = useState<AccountSignInTarget | null>(null);
  const element = target ? (
    <AddProviderAccountSheet
      // A new target is a new sheet, never the old one's state.
      key={target.existing?.id ?? `new:${target.label ?? ""}`}
      provider={provider}
      providerLabel={providerLabel}
      existingInstance={target.existing}
      initialLabel={target.label}
      defaultAccent={providerColor(provider, theme)}
      onClose={(changed) => {
        setTarget(null);
        if (changed) onChanged();
      }}
    />
  ) : null;
  return { open: setTarget, element };
}
