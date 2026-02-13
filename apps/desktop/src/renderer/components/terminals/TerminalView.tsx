import React, { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { cn } from "../ui/cn";
import { useAppStore, type ThemeId } from "../../state/appStore";

type XtermTheme = NonNullable<ConstructorParameters<typeof Terminal>[0]>["theme"];

const terminalThemes: Record<"light" | "dark", XtermTheme> = {
  light: {
    background: "#F2F0ED",
    foreground: "#1C1917",
    cursor: "#C22323",
    cursorAccent: "#FDFBF7",
    selectionBackground: "rgba(194, 35, 35, 0.16)"
  },
  dark: {
    background: "#1A1A1A",
    foreground: "#EDEDED",
    cursor: "#F59E0B",
    cursorAccent: "#0A0A0A",
    selectionBackground: "rgba(245, 158, 11, 0.26)"
  }
};

function isDarkTheme(theme: ThemeId): boolean {
  return theme === "bloomberg" || theme === "github" || theme === "rainbow" || theme === "pats";
}

export function TerminalView({ ptyId, sessionId, className }: { ptyId: string; sessionId: string; className?: string }) {
  const appTheme = useAppStore((s) => s.theme);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const resizeObsRef = useRef<ResizeObserver | null>(null);
  const lastDimsRef = useRef<{ cols: number; rows: number } | null>(null);
  const [exited, setExited] = useState<number | null>(null);

  const termTheme = useMemo(() => terminalThemes[isDarkTheme(appTheme) ? "dark" : "light"], [appTheme]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      scrollback: 6000,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      theme: termTheme
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    lastDimsRef.current = { cols: term.cols, rows: term.rows };
    window.ade.pty.resize({ ptyId, cols: term.cols, rows: term.rows }).catch(() => {});

    // Try to hydrate recent output so switching tabs doesn't feel like losing context.
    window.ade.sessions
      .readTranscriptTail({ sessionId, maxBytes: 80_000 })
      .then((text) => {
        if (text.trim().length) term.write(text);
      })
      .catch(() => {});

    term.onData((data) => {
      window.ade.pty.write({ ptyId, data }).catch(() => {});
    });

    term.attachCustomKeyEventHandler((ev) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const mod = isMac ? ev.metaKey : ev.ctrlKey;
      const key = ev.key.toLowerCase();
      if (mod && key === "v" && ev.type === "keydown") {
        // Best-effort paste.
        navigator.clipboard
          .readText()
          .then((text) => window.ade.pty.write({ ptyId, data: text }))
          .catch(() => {});
        return false;
      }
      return true;
    });

    const unsubData = window.ade.pty.onData((ev) => {
      if (ev.ptyId !== ptyId) return;
      term.write(ev.data);
    });

    const unsubExit = window.ade.pty.onExit((ev) => {
      if (ev.ptyId !== ptyId) return;
      setExited(ev.exitCode ?? 0);
    });

    const obs = new ResizeObserver(() => {
      // Throttle to animation frame to avoid spamming.
      requestAnimationFrame(() => {
        try {
          fit.fit();
          const next = { cols: term.cols, rows: term.rows };
          const prev = lastDimsRef.current;
          if (!prev || prev.cols !== next.cols || prev.rows !== next.rows) {
            lastDimsRef.current = next;
            window.ade.pty.resize({ ptyId, cols: next.cols, rows: next.rows }).catch(() => {});
          }
        } catch {
          // ignore
        }
      });
    });
    obs.observe(el);

    termRef.current = term;
    fitRef.current = fit;
    resizeObsRef.current = obs;

    return () => {
      try {
        unsubData();
        unsubExit();
      } catch {
        // ignore
      }
      try {
        obs.disconnect();
      } catch {
        // ignore
      }
      try {
        term.dispose();
      } catch {
        // ignore
      }
      termRef.current = null;
      fitRef.current = null;
      resizeObsRef.current = null;
    };
  }, [ptyId, sessionId]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options = { ...term.options, theme: termTheme ? { ...termTheme } : undefined };
  }, [termTheme]);

  return (
    <div
      className={cn(
        "relative h-full min-h-0 w-full overflow-hidden rounded-md border border-border bg-muted/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]",
        className
      )}
    >
      <div ref={containerRef} className="h-full w-full p-2" />
      {exited != null ? (
        <div className="pointer-events-none absolute bottom-2 right-2 rounded border border-border bg-bg/90 px-2 py-1 text-[11px] text-muted-fg">
          exited {exited}
        </div>
      ) : null}
    </div>
  );
}
