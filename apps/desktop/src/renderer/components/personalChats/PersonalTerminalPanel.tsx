import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { SpinnerGap, TerminalWindow, X } from "@phosphor-icons/react";
import type { PersonalChatCallArgs, PersonalChatCallResponse } from "../../../shared/types";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_PREFERENCES,
  useAppStore,
} from "../../state/appStore";

type TerminalCreateResult = {
  ptyId: string;
  sessionId: string;
  pid: number | null;
};

function terminalResult<T>(response: PersonalChatCallResponse): T {
  return response.result as T;
}

async function callTerminal<T>(request: PersonalChatCallArgs): Promise<T> {
  return terminalResult<T>(await window.ade.personalChats.call(request));
}

function eventRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function PersonalTerminalPanel({
  chatSessionId,
  onClose,
}: {
  chatSessionId: string | null;
  onClose: () => void;
}) {
  const terminalPreferences = useAppStore((state) => state.terminalPreferences);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyRef = useRef<TerminalCreateResult | null>(null);
  const lastDimsRef = useRef<{ cols: number; rows: number } | null>(null);
  const [status, setStatus] = useState<"starting" | "ready" | "exited" | "error">("starting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let pollTimer: number | null = null;
    let fitFrame: number | null = null;
    let cursor = 0;
    const preferences = terminalPreferences ?? DEFAULT_TERMINAL_PREFERENCES;
    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: true,
      fontFamily: preferences.fontFamily || DEFAULT_TERMINAL_FONT_FAMILY,
      fontSize: Math.round(preferences.fontSize),
      lineHeight: preferences.lineHeight,
      scrollback: preferences.scrollback,
      theme: {
        background: "#0c0e16",
        foreground: "#ededed",
        cursor: "#a78bfa",
        cursorAccent: "#0c0e16",
        selectionBackground: "rgba(167,139,250,0.22)",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;

    const fitTerminal = () => {
      if (cancelled || host.clientWidth < 1 || host.clientHeight < 1) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const dims = {
        cols: Math.max(20, terminal.cols),
        rows: Math.max(6, terminal.rows),
      };
      const previous = lastDimsRef.current;
      lastDimsRef.current = dims;
      const pty = ptyRef.current;
      if (pty && (previous?.cols !== dims.cols || previous?.rows !== dims.rows)) {
        void callTerminal({ action: "terminalResize", args: { ptyId: pty.ptyId, ...dims } }).catch(() => undefined);
      }
    };
    const scheduleFit = () => {
      if (fitFrame != null) window.cancelAnimationFrame(fitFrame);
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = null;
        fitTerminal();
      });
    };
    const resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(host);
    scheduleFit();

    const dataSubscription = terminal.onData((data) => {
      const pty = ptyRef.current;
      if (!pty || cancelled) return;
      void callTerminal({ action: "terminalWrite", args: { ptyId: pty.ptyId, data } }).catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    });

    const poll = async () => {
      if (cancelled || !ptyRef.current) return;
      let nextDelayMs = 75;
      try {
        const result = await window.ade.personalChats.streamEvents({ cursor, limit: 500 });
        if (cancelled) return;
        cursor = result.nextCursor ?? cursor;
        nextDelayMs = result.hasMore ? 0 : result.events.length > 0 ? 35 : 75;
        for (const entry of result.events ?? []) {
          if (entry.category !== "pty") continue;
          const payload = eventRecord(entry.payload);
          const terminalEvent = eventRecord(payload?.event);
          const pty = ptyRef.current;
          if (!payload || !terminalEvent || !pty) continue;
          const matches = terminalEvent.ptyId === pty.ptyId || terminalEvent.sessionId === pty.sessionId;
          if (!matches) continue;
          if (payload.type === "pty_data" && typeof terminalEvent.data === "string") {
            terminal.write(terminalEvent.data);
          } else if (payload.type === "pty_exit") {
            const exitCode = typeof terminalEvent.exitCode === "number" ? terminalEvent.exitCode : null;
            terminal.write(`\r\n\x1b[90m[Process exited${exitCode == null ? "" : ` with code ${exitCode}`}]\x1b[0m\r\n`);
            setStatus("exited");
          }
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!cancelled) pollTimer = window.setTimeout(poll, nextDelayMs);
      }
    };

    void (async () => {
      try {
        fitTerminal();
        const dims = lastDimsRef.current ?? { cols: 80, rows: 24 };
        const created = await callTerminal<TerminalCreateResult>({
          action: "terminalCreate",
          args: { chatSessionId, ...dims },
        });
        if (cancelled) {
          await callTerminal({
            action: "terminalDispose",
            args: { ptyId: created.ptyId, sessionId: created.sessionId },
          }).catch(() => undefined);
          return;
        }
        ptyRef.current = created;
        setStatus("ready");
        terminal.focus();
        await poll();
      } catch (reason) {
        if (!cancelled) {
          setStatus("error");
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }
    })();

    return () => {
      cancelled = true;
      if (pollTimer != null) window.clearTimeout(pollTimer);
      if (fitFrame != null) window.cancelAnimationFrame(fitFrame);
      resizeObserver.disconnect();
      dataSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      const pty = ptyRef.current;
      ptyRef.current = null;
      if (pty) {
        void callTerminal({
          action: "terminalDispose",
          args: { ptyId: pty.ptyId, sessionId: pty.sessionId },
        }).catch(() => undefined);
      }
    };
  }, [chatSessionId, terminalPreferences]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#0c0e16]" aria-label="Personal terminal">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-white/[0.07] px-2.5 text-white/55">
        <TerminalWindow size={14} />
        <span className="flex-1 font-sans text-[10px] font-medium text-white/65">Terminal</span>
        {status === "starting" ? <SpinnerGap size={12} className="animate-spin" /> : null}
        {status === "exited" ? <span className="font-mono text-[8px] uppercase tracking-wide text-white/35">Exited</span> : null}
        <button type="button" onClick={onClose} className="flex h-6 w-6 items-center justify-center rounded text-white/45 hover:bg-white/[0.07] hover:text-white" aria-label="Close terminal">
          <X size={12} />
        </button>
      </header>
      {error ? <div role="alert" className="shrink-0 border-b border-rose-400/15 bg-rose-500/10 px-3 py-2 font-sans text-[10px] text-rose-200/75">{error}</div> : null}
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden p-1" />
    </section>
  );
}
