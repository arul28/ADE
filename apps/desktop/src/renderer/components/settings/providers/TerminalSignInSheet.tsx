/**
 * A login command in a terminal (Qwen, and the CLIs on a machine whose ADE is
 * too old for the in-app sign-in): the vendor's own login in a real PTY on the
 * sheet's machine, in step 2 of the shared sign-in frame.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { TerminalView } from "../../terminals/TerminalView";
import { openExternalUrl } from "../../../lib/openExternal";
import { requirePin } from "../../../state/repositoryScope";
import { useThisComputerCopyPin } from "../ProjectCopyScope";
import type { TerminalToolType } from "../../../../shared/types";
import type { SignInStage } from "./signInSheetParts";
import { SignInSheetFrame, useSuccessHold, type SignInMachine, type SignInSheetView } from "./signInSheetFrame";

/** The terminal sign-in re-reads the saved login this often (its old cadence). */
const TERMINAL_AUTH_POLL_MS = 4_000;

const URL_PATTERN = /https?:\/\/[^\s"'<>()\]]+/g;

/**
 * The first sign-in URL in some terminal output, if there is one. Narrow on
 * purpose: a login prints one link worth opening, and opening a docs link or
 * an update notice would take over the browser for nothing.
 */
function findSignInUrl(text: string): string | null {
  const matches = text.match(URL_PATTERN);
  if (!matches?.length) return null;
  for (const raw of matches) {
    const url = raw.replace(/[.,;:]+$/, "");
    if (/(auth|login|oauth|device|verify|activate|connect|sso)/i.test(url)) return url;
  }
  return null;
}

type TerminalSignInSheetProps = SignInMachine & {
  providerId: string;
  providerLabel: string;
  /** The command the terminal runs, e.g. `qwen --auth-type=openai`. */
  command: string;
  /** `shell` by default; Muse passes `muse` so the PTY host swaps its pinned binary in. */
  toolType?: TerminalToolType;
  /** Lane to open the terminal in; null asks for the primary lane. */
  laneId?: string | null;
  /** Re-read the saved login. Resolves true once this provider is signed in. */
  checkSignedIn: () => Promise<boolean>;
  onClose: () => void;
  /** Called once, after a successful sign-in. */
  onSignedIn?: () => void;
};

/**
 * A provider whose login is a terminal flow ADE does not run headlessly: a
 * real PTY running the vendor's own login command on the sheet's machine,
 * in step 2. The first sign-in URL it prints opens in a browser once; the
 * saved login is re-read while it runs, and the sheet closes a beat after it
 * turns up. Closing always disposes the PTY.
 */
export function TerminalSignInSheet({
  providerId,
  providerLabel,
  command,
  toolType = "shell",
  laneId,
  checkSignedIn,
  onClose,
  onSignedIn,
  pin,
  isThisMachine,
  machineName,
}: TerminalSignInSheetProps) {
  // The shell runs in a lane of this project on the sheet's machine. This
  // computer with no pin (its page takes the tab's route) uses its own copy.
  const thisComputerPin = useThisComputerCopyPin(isThisMachine && !pin);
  const shellPin = pin ?? (isThisMachine ? thisComputerPin : null);
  // Effects key on the pin's identity, not the object: a rebuilt pin with the
  // same key must not restart the login shell.
  const pinRef = useRef(shellPin);
  pinRef.current = shellPin;
  const pinIdentity = shellPin?.key ?? null;
  const [terminal, setTerminal] = useState<{ ptyId: string; sessionId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const openedUrlRef = useRef<string | null>(null);
  const terminalRef = useRef<{ ptyId: string; sessionId: string } | null>(null);
  const closedRef = useRef(false);
  const title = `Sign in to ${providerLabel}`;

  // Open the PTY.
  useEffect(() => {
    let cancelled = false;
    const target = pinRef.current;
    // A new machine gets a new login shell; the old one's terminal is gone.
    setTerminal(null);
    openedUrlRef.current = null;
    setUrl(null);
    void (async () => {
      try {
        if (!window.ade?.pty?.create) throw new Error("Terminals are not available in this window.");
        const shellTarget = requirePin(target, `${machineName} has no copy of this project online.`);
        const lanes = await window.ade.lanes.list({ includeArchived: false, includeStatus: false }, shellTarget);
        const resolvedLaneId = laneId ?? lanes.find((lane) => lane.laneType === "primary")?.id ?? lanes[0]?.id ?? null;
        if (!resolvedLaneId) throw new Error("No lane is available to run the login in.");
        const created = await window.ade.pty.create({
          laneId: resolvedLaneId,
          cols: 100,
          rows: 24,
          title,
          // Not tracked: a one-shot login shell, not an agent session; tracking
          // it would put a phantom row in Work.
          tracked: false,
          toolType,
          startupCommand: command,
        }, shellTarget);
        if (cancelled) {
          void window.ade.pty.dispose({ ptyId: created.ptyId, sessionId: created.sessionId }, shellTarget);
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
  }, [command, laneId, machineName, pinIdentity, title, toolType]);

  // Dispose on unmount, always.
  useEffect(() => {
    const target = pinRef.current;
    return () => {
      const open = terminalRef.current;
      terminalRef.current = null;
      if (open && target) void window.ade?.pty?.dispose({ ptyId: open.ptyId, sessionId: open.sessionId }, target);
    };
  }, [pinIdentity]);

  // Open the first sign-in URL it prints, once.
  useEffect(() => {
    const target = pinRef.current;
    if (!terminal || !target || !window.ade?.pty?.onData) return;
    const unsubscribe = window.ade.pty.onData((event) => {
      if (event.ptyId !== terminal.ptyId) return;
      if (openedUrlRef.current) return;
      const found = findSignInUrl(event.data ?? "");
      if (!found) return;
      openedUrlRef.current = found;
      setUrl(found);
      openExternalUrl(found);
    }, target);
    return unsubscribe;
  }, [pinIdentity, terminal]);

  // Watch for the saved login.
  // Read through refs: a caller's inline function must not restart the timer.
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;
  const checkSignedInRef = useRef(checkSignedIn);
  checkSignedInRef.current = checkSignedIn;
  useEffect(() => {
    if (!terminal || signedIn) return;
    let stopped = false;
    const timer = setInterval(() => {
      void checkSignedInRef.current()
        .then((ok) => {
          if (stopped || !ok) return;
          setSignedIn(true);
          onSignedInRef.current?.();
        })
        .catch(() => {
          // A failed re-read is not a failed login. Keep watching.
        });
    }, TERMINAL_AUTH_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [signedIn, terminal]);

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose();
  }, [onClose]);

  const stage: SignInStage = error ? "failed" : signedIn ? "done" : terminal ? "waiting" : "starting";
  useSuccessHold(stage, close);

  const view: SignInSheetView = {
    stage,
    startHint: "Starting a terminal…",
    url,
    deviceCode: null,
    approveLabel: "Finish in the terminal",
    codeHint: url ? "Not in your browser? Click Open sign-in page." : null,
    stepExtra: terminal ? (
      <>
        <span className="ade-sis-hint">
          ADE runs <code>{command}</code> here. Answer its questions; the sheet closes once you are signed in.
        </span>
        {/*
          A definite height, not just a min-height: TerminalView fills its
          parent with `h-full`, which is 0 against a box sized only by
          min-height, and a 0-height host never subscribes to its PTY.
        */}
        <div className="ade-sis-terminal">
          <TerminalView
            key={`${providerId}:${terminal.sessionId}`}
            ptyId={terminal.ptyId}
            sessionId={terminal.sessionId}
            runtimePin={shellPin}
            isActive
            className="h-full w-full"
          />
        </div>
      </>
    ) : null,
    expectedAccount: null,
    account: null,
    failure: error ? { title: "The sign-in could not start.", detail: error } : null,
  };

  return (
    <SignInSheetFrame
      providerId={providerId}
      providerLabel={providerLabel}
      title={title}
      machine={{ pin, isThisMachine, machineName }}
      view={view}
      onClose={close}
      width={720}
    />
  );
}
