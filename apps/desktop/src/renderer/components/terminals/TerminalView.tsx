import React, { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { cn } from "../ui/cn";
import { useAppStore, type ThemeId } from "../../state/appStore";

type XtermTheme = NonNullable<ConstructorParameters<typeof Terminal>[0]>["theme"];
type XtermCoreLike = {
  _core?: {
    _coreBrowserService?: { window?: Window };
    _viewport?: {
      _innerRefresh?: () => void;
      syncScrollArea?: (immediate?: boolean) => void;
      _refreshAnimationFrame?: number | null;
      __adeSafeRefreshPatched?: boolean;
      __adeSafeSyncPatched?: boolean;
    };
  };
};

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

function patchViewportRefresh(term: Terminal): void {
  // xterm can throw in Viewport._innerRefresh when a pane is mounted/unmounted quickly.
  try {
    const core = (term as unknown as XtermCoreLike)._core;
    const viewport = core?._viewport;
    if (!viewport || typeof viewport._innerRefresh !== "function" || viewport.__adeSafeRefreshPatched) return;
    const original = viewport._innerRefresh.bind(viewport);
    viewport._innerRefresh = () => {
      try {
        original();
      } catch {
        // Ignore transient teardown races inside xterm internals.
      }
    };
    viewport.__adeSafeRefreshPatched = true;
    if (typeof viewport.syncScrollArea === "function" && !viewport.__adeSafeSyncPatched) {
      const originalSync = viewport.syncScrollArea.bind(viewport);
      viewport.syncScrollArea = (immediate?: boolean) => {
        try {
          originalSync(immediate);
        } catch {
          // Ignore transient teardown races inside xterm internals.
        }
      };
      viewport.__adeSafeSyncPatched = true;
    }
  } catch {
    // Ignore internal access failures across xterm versions.
  }
}

function cancelViewportRaf(term: Terminal): void {
  try {
    const core = (term as unknown as XtermCoreLike)._core;
    const viewport = core?._viewport;
    if (!viewport) return;
    const rafId = viewport._refreshAnimationFrame;
    const rafWindow = core?._coreBrowserService?.window ?? window;
    if (typeof rafId === "number") {
      rafWindow.cancelAnimationFrame(rafId);
      viewport._refreshAnimationFrame = null;
    }
  } catch {
    // Ignore internal access failures across xterm versions.
  }
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
    let cancelled = false;

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
    let fitRafId: number | null = null;
    let initialRafId: number | null = null;

    const ensureOpen = () => {
      if (cancelled) return false;
      if (term.element) return true;
      if (!el.isConnected) return false;
      if (el.clientWidth === 0 || el.clientHeight === 0) return false;
      try {
        term.open(el);
      } catch {
        return false;
      }
      patchViewportRefresh(term);
      return true;
    };

    const doFit = () => {
      if (cancelled) return;
      if (!ensureOpen()) return;
      if (!el.isConnected) return;
      // xterm can misbehave if we try to fit while hidden/zero-sized.
      if (el.clientWidth === 0 || el.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const next = { cols: term.cols, rows: term.rows };
      if (!Number.isFinite(next.cols) || !Number.isFinite(next.rows) || next.cols <= 0 || next.rows <= 0) return;
      const prev = lastDimsRef.current;
      if (!prev || prev.cols !== next.cols || prev.rows !== next.rows) {
        lastDimsRef.current = next;
        window.ade.pty.resize({ ptyId, cols: next.cols, rows: next.rows }).catch(() => {});
      }
    };

    const scheduleFit = () => {
      if (cancelled) return;
      if (fitRafId != null) cancelAnimationFrame(fitRafId);
      fitRafId = requestAnimationFrame(() => {
        fitRafId = null;
        doFit();
      });
    };

    // Allow layout to settle before first fit (helps in StrictMode/dev + tab switching).
    initialRafId = requestAnimationFrame(() => {
      initialRafId = null;
      scheduleFit();
    });

    // Try to hydrate recent output so switching tabs doesn't feel like losing context.
    window.ade.sessions
      .readTranscriptTail({ sessionId, maxBytes: 80_000 })
      .then((text) => {
        if (cancelled) return;
        if (!text.trim().length) return;
        try {
          term.write(text);
        } catch {
          // Ignore writes after disposal/unmount.
        }
      })
      .catch(() => {});

    const dataSub = term.onData((data) => {
      if (cancelled) return;
      window.ade.pty.write({ ptyId, data }).catch(() => {});
    });

    term.attachCustomKeyEventHandler((ev) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const mod = isMac ? ev.metaKey : ev.ctrlKey;
      const key = ev.key.toLowerCase();

      if (ev.type !== "keydown") return true;

      // Cmd+V: handle paste
      if (mod && key === "v") {
        navigator.clipboard
          .readText()
          .then((text) => {
            if (cancelled) return;
            return window.ade.pty.write({ ptyId, data: text });
          })
          .catch(() => {});
        return false;
      }

      // Cmd+C: copy if selection exists, otherwise let xterm handle (SIGINT)
      if (mod && key === "c") {
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch(() => {});
          return false;
        }
        // No selection - let xterm send SIGINT
        return true;
      }

      // Shift+Enter: send newline (same as Enter)
      if (ev.shiftKey && ev.key === "Enter") {
        ev.preventDefault();
        window.ade.pty.write({ ptyId, data: "\r" }).catch(() => {});
        return false;
      }

      // Option+Backspace (Mac): delete previous word
      if (isMac && ev.altKey && ev.key === "Backspace") {
        ev.preventDefault();
        window.ade.pty.write({ ptyId, data: "\x1b\x7f" }).catch(() => {});
        return false;
      }

      // Cmd+Backspace (Mac): delete to beginning of line
      if (isMac && ev.metaKey && ev.key === "Backspace") {
        ev.preventDefault();
        window.ade.pty.write({ ptyId, data: "\x15" }).catch(() => {});
        return false;
      }

      // Let ALL other keys pass through to xterm
      return true;
    });

    const unsubData = window.ade.pty.onData((ev) => {
      if (ev.ptyId !== ptyId) return;
      if (cancelled) return;
      try {
        term.write(ev.data);
      } catch {
        // Ignore writes after disposal/unmount.
      }
    });

    const unsubExit = window.ade.pty.onExit((ev) => {
      if (ev.ptyId !== ptyId) return;
      if (cancelled) return;
      setExited(ev.exitCode ?? 0);
    });

    const obs = new ResizeObserver(() => {
      // Throttle to animation frame to avoid spamming.
      scheduleFit();
    });
    obs.observe(el);

    const intObs = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) scheduleFit();
      }
    });
    intObs.observe(el);

    // Watch for visibility changes via CSS class toggling (invisible/pointer-events-none)
    const mutObs = new MutationObserver(() => {
      if (cancelled) return;
      // Check if our container is currently visible
      const parentEl = el.parentElement;
      if (!parentEl) return;
      const isHidden = parentEl.classList.contains('invisible');
      if (!isHidden && el.isConnected && el.clientWidth > 0 && el.clientHeight > 0) {
        // Terminal just became visible - schedule a double-RAF fit
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            doFit();
          });
        });
      }
    });

    // Observe the parent element for class changes
    const parentEl = el.parentElement;
    if (parentEl) {
      mutObs.observe(parentEl, { attributes: true, attributeFilter: ['class'] });
    }

    termRef.current = term;
    fitRef.current = fit;
    resizeObsRef.current = obs;

    return () => {
      cancelled = true;
      if (initialRafId != null) {
        cancelAnimationFrame(initialRafId);
      }
      if (fitRafId != null) {
        cancelAnimationFrame(fitRafId);
      }
      try {
        unsubData();
        unsubExit();
      } catch {
        // ignore
      }
      try {
        dataSub.dispose();
      } catch {
        // ignore
      }
      try {
        obs.disconnect();
      } catch {
        // ignore
      }
      try {
        intObs.disconnect();
      } catch {
        // ignore
      }
      try { mutObs.disconnect(); } catch { /* ignore */ }
      cancelViewportRaf(term);
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
    // Avoid reassigning `term.options` wholesale. Some options (cols/rows) are readonly after construction
    // and xterm will throw if we try to set them via the options setter.
    // Defer theme update to next frame so the renderer is fully initialised.
    const id = requestAnimationFrame(() => {
      try {
        term.options.theme = termTheme ? { ...termTheme } : undefined;
      } catch {
        // Ignore if terminal was disposed or renderer not ready.
      }
    });
    return () => cancelAnimationFrame(id);
  }, [termTheme]);

  return (
    <div
      className={cn(
        "relative h-full min-h-0 w-full overflow-hidden rounded-xl bg-muted/70 shadow-card",
        className
      )}
    >
      <div ref={containerRef} className="h-full w-full p-2" />
      {exited != null ? (
        <div className="pointer-events-none absolute bottom-2 right-2 rounded-lg bg-bg/90 shadow-card px-2 py-1 text-[11px] text-muted-fg">
          exited {exited}
        </div>
      ) : null}
    </div>
  );
}
