/**
 * Add a second (or third) login for one provider.
 *
 * The sheet is deliberately two beats: name the account, then watch its own
 * sign-in run. ADE never drives the vendor's OAuth itself — the store hands
 * back the exact command, argv and env that make the provider CLI write its
 * credentials into THIS account's config home, and the sheet runs that in a
 * real PTY, the same `window.ade.pty.create` + `TerminalView` pair the provider
 * sign-in modal uses. Nothing here spawns a process from the renderer.
 *
 * The outcome is read, not assumed: when the PTY exits the registry is
 * refreshed once and the instance is re-read. A login that exited without
 * writing credentials says so, with a way to try again — the failure mode this
 * replaces is a sheet that closes on exit and leaves a signed-out account in
 * the list with no explanation.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle, CircleNotch, X } from "@phosphor-icons/react";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  outlineButton,
  primaryButton,
} from "../../../lanes/laneDesignTokens";
import { TerminalView } from "../../../terminals/TerminalView";
import type {
  ProviderInstance,
  ProviderInstanceLoginCommand,
  ProviderInstanceProvider,
} from "../../../../../shared/types/providerInstances";
import { AccentSwatchRow } from "./AccentSwatchRow";
import { accountIdentityLine } from "./accountPresentation";
import { providerActionMessage } from "../providerErrorMessage";

/** How long `✓ <email>` stays up before the sheet closes itself. */
const SUCCESS_HOLD_MS = 1_500;

type Phase = "form" | "terminal" | "success" | "failed";

export type AddProviderAccountSheetProps = {
  provider: ProviderInstanceProvider;
  providerLabel: string;
  /** Present when reopening sign-in for an account that already exists. */
  existingInstance?: ProviderInstance | null;
  /** Suggested accent for a brand-new account — the provider's own colour. */
  defaultAccent: string;
  /** Called on every close. `changed` is true once anything was written. */
  onClose: (changed: boolean) => void;
};

export function AddProviderAccountSheet({
  provider,
  providerLabel,
  existingInstance,
  defaultAccent,
  onClose,
}: AddProviderAccountSheetProps) {
  const resuming = Boolean(existingInstance);
  const [phase, setPhase] = useState<Phase>(resuming ? "terminal" : "form");
  const [label, setLabel] = useState("");
  const [accent, setAccent] = useState<string | null>(defaultAccent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [terminal, setTerminal] = useState<{ ptyId: string; sessionId: string } | null>(null);
  const [signedInAs, setSignedInAs] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const instanceIdRef = useRef<string | null>(existingInstance?.id ?? null);
  const terminalRef = useRef<{ ptyId: string; sessionId: string } | null>(null);
  const changedRef = useRef(false);
  const closedRef = useRef(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const disposeTerminal = useCallback(() => {
    const open = terminalRef.current;
    terminalRef.current = null;
    setTerminal(null);
    if (open) void window.ade?.pty?.dispose({ ptyId: open.ptyId, sessionId: open.sessionId });
  }, []);

  // Always dispose: a login shell left running behind a closed sheet is a leak
  // nobody can see.
  useEffect(() => () => {
    const open = terminalRef.current;
    terminalRef.current = null;
    if (open) void window.ade?.pty?.dispose({ ptyId: open.ptyId, sessionId: open.sessionId });
  }, []);

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose(changedRef.current);
  }, [onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  /** Start the provider's own login in a PTY bound to this account's config home. */
  const runLogin = useCallback(async (login: ProviderInstanceLoginCommand) => {
    if (!window.ade?.pty?.create) throw new Error("Terminals are not available in this window.");
    const lanes = await window.ade.lanes.list({ includeArchived: false, includeStatus: false });
    const laneId = lanes.find((lane) => lane.laneType === "primary")?.id ?? lanes[0]?.id ?? null;
    if (!laneId) throw new Error("No lane is available to run the sign-in in.");
    const created = await window.ade.pty.create({
      laneId,
      cols: 100,
      rows: 20,
      title: `Sign in to ${providerLabel}`,
      // Not tracked: a one-shot login shell, not an agent session. Tracking it
      // would leave a phantom row in Work.
      tracked: false,
      toolType: "shell",
      command: login.command,
      args: login.args,
      env: login.env,
    });
    if (!aliveRef.current) {
      void window.ade.pty.dispose({ ptyId: created.ptyId, sessionId: created.sessionId });
      return;
    }
    terminalRef.current = { ptyId: created.ptyId, sessionId: created.sessionId };
    setTerminal({ ptyId: created.ptyId, sessionId: created.sessionId });
  }, [providerLabel]);

  /** One refresh, then re-read this instance. Never a polling loop. */
  const checkSignedIn = useCallback(async (): Promise<boolean> => {
    const api = window.ade?.providerInstances;
    const id = instanceIdRef.current;
    if (!api || !id) return false;
    const list = await api.refresh({ provider });
    const instance = list.find((entry) => entry.id === id);
    if (!instance?.signedIn) return false;
    if (aliveRef.current) {
      setSignedInAs(accountIdentityLine(instance));
      setPhase("success");
    }
    return true;
  }, [provider]);

  // ── Create the account, then start its sign-in ──
  const startCreate = useCallback(async () => {
    const api = window.ade?.providerInstances;
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
      setPhase("terminal");
      await runLogin(created.loginCommand);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(providerActionMessage(err, "That sign-in could not be started."));
      setPhase("form");
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [accent, label, provider, runLogin]);

  // ── Reopening sign-in for an account that already exists ──
  const startResume = useCallback(async () => {
    const api = window.ade?.providerInstances;
    const id = instanceIdRef.current;
    if (!api || !id) {
      setError("Provider accounts are not available in this window.");
      return;
    }
    setError(null);
    setPhase("terminal");
    try {
      const login = await api.loginCommand({ id });
      await runLogin(login);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(providerActionMessage(err, "That sign-in could not be started."));
      setPhase("failed");
    }
  }, [runLogin]);

  const startedRef = useRef(false);
  useEffect(() => {
    if (!resuming || startedRef.current) return;
    startedRef.current = true;
    void startResume();
  }, [resuming, startResume]);

  // ── The PTY exiting is the signal to read the outcome, once ──
  useEffect(() => {
    if (!terminal || !window.ade?.pty?.onExit) return;
    const unsubscribe = window.ade.pty.onExit((event) => {
      if (event.ptyId !== terminal.ptyId) return;
      void checkSignedIn()
        .then((ok) => {
          if (!aliveRef.current) return;
          changedRef.current = true;
          if (!ok) setPhase("failed");
        })
        .catch(() => {
          if (aliveRef.current) setPhase("failed");
        });
    });
    return unsubscribe;
  }, [checkSignedIn, terminal]);

  // ── Success beat, then close ──
  useEffect(() => {
    if (phase !== "success") return;
    const timer = setTimeout(close, SUCCESS_HOLD_MS);
    return () => clearTimeout(timer);
  }, [close, phase]);

  const onCheckAgain = useCallback(() => {
    setChecking(true);
    void checkSignedIn()
      .catch(() => {
        // A failed re-check is not a failed login — the terminal is still there.
      })
      .finally(() => {
        if (aliveRef.current) setChecking(false);
      });
  }, [checkSignedIn]);

  const onTryAgain = useCallback(() => {
    disposeTerminal();
    setError(null);
    setPhase("terminal");
    void startResume();
  }, [disposeTerminal, startResume]);

  const title = resuming
    ? `Sign in to ${providerLabel}`
    : `Add a ${providerLabel} account`;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.70)" }}
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-2xl outline-none"
        style={{
          background: COLORS.cardBgSolid,
          border: `1px solid ${COLORS.outlineBorder}`,
          boxShadow: "0 28px 80px -36px rgba(0,0,0,0.82)",
          display: "flex",
          flexDirection: "column",
          maxHeight: "82vh",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "0 16px",
            height: 48,
            flexShrink: 0,
            borderBottom: `1px solid ${COLORS.border}`,
          }}
        >
          <div style={{ fontSize: 13, fontFamily: SANS_FONT, fontWeight: 700, color: COLORS.textPrimary }}>
            {title}
          </div>
          <button
            type="button"
            aria-label="Close add account"
            onClick={close}
            style={{ ...outlineButton({ height: 26 }), width: 26, padding: 0, justifyContent: "center" }}
          >
            <X size={12} weight="bold" />
          </button>
        </div>

        {error ? (
          <div
            role="alert"
            style={{
              padding: "8px 16px",
              fontSize: 11,
              fontFamily: SANS_FONT,
              lineHeight: 1.5,
              color: COLORS.danger,
              background: "color-mix(in srgb, var(--color-error) 10%, transparent)",
              borderBottom: `1px solid ${COLORS.border}`,
              overflowWrap: "anywhere",
            }}
          >
            {error}
          </div>
        ) : null}

        {phase === "form" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: 16 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim }}>Label</span>
              <input
                aria-label="Account label"
                value={label}
                autoFocus
                placeholder="Work"
                onChange={(event) => setLabel(event.target.value)}
                style={{
                  height: 28,
                  padding: "0 8px",
                  fontSize: 12,
                  fontFamily: SANS_FONT,
                  color: COLORS.textPrimary,
                  background: COLORS.cardBg,
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 6,
                  outline: "none",
                }}
              />
            </label>

            <AccentSwatchRow value={accent} onChange={setAccent} />

            <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
              This account gets its own sign-in. Your other accounts are not touched.
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                style={primaryButton({ height: 28 })}
                disabled={busy || label.trim().length === 0}
                onClick={() => void startCreate()}
              >
                {busy ? "Starting…" : "Sign in →"}
              </button>
            </div>
          </div>
        ) : null}

        {phase !== "form" ? (
          <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
            <div style={{ flex: 1, minHeight: 260, display: "flex", flexDirection: "column" }}>
              {terminal ? (
                <TerminalView
                  key={terminal.sessionId}
                  ptyId={terminal.ptyId}
                  sessionId={terminal.sessionId}
                  isActive
                  className="h-full w-full"
                />
              ) : (
                <div style={{ padding: 16, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
                  Starting a terminal…
                </div>
              )}
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 16px",
                flexShrink: 0,
                borderTop: `1px solid ${COLORS.border}`,
              }}
            >
              {phase === "terminal" ? (
                <>
                  <span
                    role="status"
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted }}
                  >
                    <CircleNotch size={12} />
                    Waiting for sign-in…
                  </span>
                  <button
                    type="button"
                    onClick={onCheckAgain}
                    disabled={checking}
                    style={{
                      marginLeft: "auto",
                      background: "transparent",
                      border: "none",
                      padding: 0,
                      fontSize: 11,
                      fontFamily: SANS_FONT,
                      color: COLORS.accent,
                      cursor: "pointer",
                    }}
                  >
                    {checking ? "Checking…" : "Check again"}
                  </button>
                </>
              ) : null}

              {phase === "success" ? (
                <span
                  role="status"
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.success }}
                >
                  <CheckCircle size={13} weight="fill" />
                  {signedInAs ?? "Signed in"}
                </span>
              ) : null}

              {phase === "failed" ? (
                <>
                  <span role="status" style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
                    Sign-in did not complete.
                  </span>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                    <button type="button" style={outlineButton({ height: 26 })} onClick={onTryAgain}>
                      Try again
                    </button>
                    <button type="button" style={outlineButton({ height: 26 })} onClick={close}>
                      Close
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
