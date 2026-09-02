/**
 * Sign in to a provider without leaving the page you asked from.
 *
 * A provider login is a terminal flow — a device code to read, a URL to open, a
 * prompt to answer — so this hosts a real PTY running the vendor's own login
 * command rather than reimplementing four OAuth dances ADE does not own. It is
 * the same `window.ade.pty.create` the Claude login button uses and the same
 * `TerminalView` the Work tab renders; only the frame is new.
 *
 * Three behaviours make it feel finished:
 *
 * - the first OAuth URL in the output is opened in a browser, once, so nobody
 *   has to copy a link out of a terminal;
 * - the provider's auth status is re-read while the terminal is open, and the
 *   modal closes itself a beat after it turns green;
 * - closing by hand always works, and always disposes the PTY — a login shell
 *   left running behind a closed dialog is a leak nobody can see.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle, X } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../../lanes/laneDesignTokens";
import { TerminalView } from "../../terminals/TerminalView";
import { openExternalUrl } from "../../../lib/openExternal";

/**
 * Poll cadence for "are we signed in yet".
 *
 * Each tick is a forced status refresh, which re-reads credentials off disk —
 * cheap, and it is the disk write that a completed `<cli> login` produces. The
 * protocol probe behind it keeps its own TTL so this cannot become a spawn
 * storm.
 */
const AUTH_POLL_MS = 4_000;
/** How long the success state stays up before the modal closes itself. */
const SUCCESS_HOLD_MS = 1_200;

const URL_PATTERN = /https?:\/\/[^\s"'<>()\]]+/g;

/**
 * The first sign-in URL in some terminal output, if there is one.
 *
 * Deliberately narrow: a login flow prints exactly one link worth opening, and
 * auto-opening a docs link or an update notice would hijack the browser for no
 * reason.
 */
export function findSignInUrl(text: string): string | null {
  const matches = text.match(URL_PATTERN);
  if (!matches?.length) return null;
  for (const raw of matches) {
    const url = raw.replace(/[.,;:]+$/, "");
    if (/(auth|login|oauth|device|verify|activate|connect|sso)/i.test(url)) return url;
  }
  return null;
}

export type ProviderSignInModalProps = {
  providerId: string;
  providerLabel: string;
  /** The command the terminal runs, e.g. `kimi login`. */
  command: string;
  /** Lane to open the terminal in. Resolved by the caller; null asks for the primary lane. */
  laneId?: string | null;
  /** Re-read auth status. Resolves true once this provider is signed in. */
  checkSignedIn: () => Promise<boolean>;
  onClose: () => void;
  /** Called once, after a successful sign-in, so the caller can refresh its own view. */
  onSignedIn?: () => void;
};

export function ProviderSignInModal({
  providerId,
  providerLabel,
  command,
  laneId,
  checkSignedIn,
  onClose,
  onSignedIn,
}: ProviderSignInModalProps) {
  const [terminal, setTerminal] = useState<{ ptyId: string; sessionId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const openedUrlRef = useRef<string | null>(null);
  const terminalRef = useRef<{ ptyId: string; sessionId: string } | null>(null);
  const closedRef = useRef(false);

  const title = useMemo(() => `Sign in to ${providerLabel}`, [providerLabel]);

  // ── Open the PTY ──
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!window.ade?.pty?.create) throw new Error("Terminals are not available in this window.");
        const lanes = await window.ade.lanes.list({
          includeArchived: false,
          includeStatus: false,
        });
        const resolvedLaneId = laneId ?? lanes.find((lane) => lane.laneType === "primary")?.id
          ?? lanes[0]?.id
          ?? null;
        if (!resolvedLaneId) throw new Error("No lane is available to run the login in.");
        const created = await window.ade.pty.create({
          laneId: resolvedLaneId,
          cols: 100,
          rows: 24,
          title,
          // Not tracked: this is a one-shot login shell, not an agent session,
          // and tracking it would put a phantom row in Work.
          tracked: false,
          toolType: "shell",
          startupCommand: command,
        });
        if (cancelled) {
          void window.ade.pty.dispose({ ptyId: created.ptyId, sessionId: created.sessionId });
          return;
        }
        terminalRef.current = { ptyId: created.ptyId, sessionId: created.sessionId };
        setTerminal({ ptyId: created.ptyId, sessionId: created.sessionId });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [command, laneId, title]);

  // ── Dispose on unmount, always ──
  useEffect(() => () => {
    const open = terminalRef.current;
    terminalRef.current = null;
    if (open) void window.ade?.pty?.dispose({ ptyId: open.ptyId, sessionId: open.sessionId });
  }, []);

  // ── Open the first sign-in URL we see, once ──
  useEffect(() => {
    if (!terminal || !window.ade?.pty?.onData) return;
    const unsubscribe = window.ade.pty.onData((event) => {
      if (event.ptyId !== terminal.ptyId) return;
      if (openedUrlRef.current) return;
      const url = findSignInUrl(event.data ?? "");
      if (!url) return;
      openedUrlRef.current = url;
      openExternalUrl(url);
    });
    return unsubscribe;
  }, [terminal]);

  // ── Watch for the auth status flipping green ──
  useEffect(() => {
    if (!terminal || signedIn) return;
    let stopped = false;
    const timer = setInterval(() => {
      void checkSignedIn()
        .then((ok) => {
          if (stopped || !ok) return;
          setSignedIn(true);
          onSignedIn?.();
        })
        .catch(() => {
          // A failed re-check is not a failed login. Keep watching; the manual
          // close is always there.
        });
    }, AUTH_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [checkSignedIn, onSignedIn, signedIn, terminal]);

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose();
  }, [onClose]);

  // ── Success beat, then close ──
  useEffect(() => {
    if (!signedIn) return;
    const timer = setTimeout(close, SUCCESS_HOLD_MS);
    return () => clearTimeout(timer);
  }, [close, signedIn]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

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
        className="w-full max-w-3xl outline-none"
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
            height: 52,
            flexShrink: 0,
            borderBottom: `1px solid ${COLORS.border}`,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontFamily: SANS_FONT, fontWeight: 700, color: COLORS.textPrimary }}>
              {title}
            </div>
            <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>{command}</div>
          </div>
          <button
            type="button"
            aria-label="Close sign in"
            onClick={close}
            style={{ ...outlineButton({ height: 26 }), width: 26, padding: 0, justifyContent: "center" }}
          >
            <X size={12} weight="bold" />
          </button>
        </div>

        {signedIn ? (
          <div
            role="status"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 16px",
              flexShrink: 0,
              fontSize: 11,
              fontFamily: MONO_FONT,
              color: COLORS.success,
              borderBottom: `1px solid ${COLORS.border}`,
            }}
          >
            <CheckCircle size={13} weight="fill" />
            Signed in to {providerLabel}.
          </div>
        ) : null}

        <div style={{ flex: 1, minHeight: 320, display: "flex", flexDirection: "column" }}>
          {error ? (
            <div
              role="alert"
              style={{ padding: 16, fontSize: 11, fontFamily: SANS_FONT, lineHeight: 1.5, color: COLORS.danger, overflowWrap: "anywhere" }}
            >
              {error}
            </div>
          ) : terminal ? (
            <TerminalView
              key={`${providerId}:${terminal.sessionId}`}
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
      </div>
    </div>,
    document.body,
  );
}
