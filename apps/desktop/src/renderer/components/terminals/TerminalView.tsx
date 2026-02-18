import React, { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { cn } from "../ui/cn";
import { useAppStore, type ThemeId } from "../../state/appStore";

type XtermTheme = NonNullable<ConstructorParameters<typeof Terminal>[0]>["theme"];

const HYDRATE_TAIL_BYTES = 240_000;
const MAX_PENDING_PTY_BYTES = 400_000;

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

function computeSuffixPrefixOverlap(left: string, right: string, maxChars = 12_000): number {
  if (!left.length || !right.length) return 0;
  const cap = Math.min(maxChars, left.length, right.length);
  for (let size = cap; size > 0; size -= 1) {
    if (left.slice(left.length - size) === right.slice(0, size)) {
      return size;
    }
  }
  return 0;
}

function trimToLikelyTerminalFrameBoundary(raw: string): string {
  if (!raw.length) return raw;
  // For full-screen TUIs, replaying from the middle of a control stream can
  // duplicate regions/cursors. Start from the latest major reset/frame marker.
  const markers = ["\x1b[H\x1b[2J", "\x1b[2J", "\x1b[3J", "\x1bc", "\x1b[?1049h", "\x1b[?1049l"];
  let idx = -1;
  for (const marker of markers) {
    const markerIdx = raw.lastIndexOf(marker);
    if (markerIdx > idx) idx = markerIdx;
  }
  if (idx <= 0) return raw;
  if (raw.length - idx < 16) return raw;
  return raw.slice(idx);
}

export function TerminalView({ ptyId, sessionId, className }: { ptyId: string; sessionId: string; className?: string }) {
  const appTheme = useAppStore((s) => s.theme);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const lastDimsRef = useRef<{ cols: number; rows: number } | null>(null);
  const [exited, setExited] = useState<number | null>(null);

  const termTheme = useMemo(() => terminalThemes[isDarkTheme(appTheme) ? "dark" : "light"], [appTheme]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setExited(null);
    let disposed = false;

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
    termRef.current = term;

    let fitRafId: number | null = null;
    let settleTimer1: ReturnType<typeof setTimeout> | null = null;
    let settleTimer2: ReturnType<typeof setTimeout> | null = null;
    let hydrateRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingForceResize = false;
    let teardownDprListener: (() => void) | null = null;

    const ensureOpen = () => {
      if (disposed) return false;
      if (term.element) return true;
      if (!el.isConnected) return false;
      if (el.clientWidth === 0 || el.clientHeight === 0) return false;
      try {
        term.open(el);
      } catch {
        return false;
      }
      return true;
    };

    let hasFittedOnce = false;
    let hydrationCompleted = false;
    const pendingPtyChunks: string[] = [];
    let pendingPtyBytes = 0;

    const doFit = (forcePtyResize = false) => {
      if (disposed) return;
      if (!ensureOpen()) return;
      if (!el.isConnected || el.clientWidth <= 0 || el.clientHeight <= 0) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const next = { cols: term.cols, rows: term.rows };
      if (!Number.isFinite(next.cols) || !Number.isFinite(next.rows) || next.cols <= 0 || next.rows <= 0) return;
      hasFittedOnce = true;
      const prev = lastDimsRef.current;
      if (!prev || prev.cols !== next.cols || prev.rows !== next.rows || forcePtyResize) {
        lastDimsRef.current = next;
        window.ade.pty.resize({ ptyId, cols: next.cols, rows: next.rows }).catch(() => {});
      }
      try {
        term.refresh(0, Math.max(0, term.rows - 1));
      } catch {
        // Ignore if terminal was disposed.
      }
    };

    const scheduleFit = (forcePtyResize = false) => {
      if (disposed) return;
      pendingForceResize = pendingForceResize || forcePtyResize;
      if (fitRafId != null) return;
      fitRafId = requestAnimationFrame(() => {
        fitRafId = null;
        const shouldForceResize = pendingForceResize;
        pendingForceResize = false;
        doFit(shouldForceResize);
      });
    };

    scheduleFit(true);
    settleTimer1 = setTimeout(() => {
      settleTimer1 = null;
      scheduleFit(true);
    }, 120);
    settleTimer2 = setTimeout(() => {
      settleTimer2 = null;
      scheduleFit(true);
    }, 320);

    const flushHydrationData = (tail: string) => {
      const stabilizedTail = trimToLikelyTerminalFrameBoundary(tail);
      const pending = pendingPtyChunks.join("");
      pendingPtyChunks.length = 0;
      pendingPtyBytes = 0;
      const overlap = computeSuffixPrefixOverlap(stabilizedTail, pending);
      let appendPending = true;
      if (pending.length >= 8_000 && overlap < 64) {
        const probe = pending.slice(0, Math.min(512, pending.length));
        if (probe.length >= 64 && stabilizedTail.lastIndexOf(probe) !== -1) {
          appendPending = false;
        }
      }
      const merged = appendPending ? `${stabilizedTail}${pending.slice(overlap)}` : stabilizedTail;
      if (!merged.length) return;
      try {
        term.write(merged);
        requestAnimationFrame(() => {
          try {
            term.refresh(0, Math.max(0, term.rows - 1));
            term.scrollToBottom();
          } catch {
            // Ignore if terminal was disposed.
          }
        });
      } catch {
        // Ignore writes after disposal/unmount.
      }
    };

    const hydrateTranscript = () => {
      window.ade.sessions
        .readTranscriptTail({ sessionId, maxBytes: HYDRATE_TAIL_BYTES, raw: true })
        .then((text) => {
          if (disposed) return;
          flushHydrationData(text);
          hydrationCompleted = true;
          scheduleFit(true);
        })
        .catch(() => {
          if (disposed) return;
          flushHydrationData("");
          hydrationCompleted = true;
          scheduleFit(true);
        });
    };

    const waitForFirstFitThenHydrate = (attempt: number) => {
      if (disposed) return;
      if (hasFittedOnce || attempt >= 20) {
        hydrateTranscript();
        return;
      }
      hydrateRetryTimer = setTimeout(() => {
        hydrateRetryTimer = null;
        waitForFirstFitThenHydrate(attempt + 1);
      }, 60);
    };
    // Wait for the first successful fit so line wrapping remains stable.
    const hydrateTimer = setTimeout(() => {
      if (disposed) return;
      waitForFirstFitThenHydrate(0);
    }, 120);

    const dataSub = term.onData((data) => {
      if (disposed) return;
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
            if (disposed) return;
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
      if (disposed) return;
      if (!hydrationCompleted) {
        pendingPtyChunks.push(ev.data);
        pendingPtyBytes += ev.data.length;
        while (pendingPtyBytes > MAX_PENDING_PTY_BYTES && pendingPtyChunks.length > 1) {
          const dropped = pendingPtyChunks.shift();
          pendingPtyBytes -= dropped?.length ?? 0;
        }
        return;
      }
      try {
        term.write(ev.data);
      } catch {
        // Ignore writes after disposal/unmount.
      }
    });

    const unsubExit = window.ade.pty.onExit((ev) => {
      if (ev.ptyId !== ptyId) return;
      if (disposed) return;
      setExited(ev.exitCode ?? 0);
    });

    const obs = new ResizeObserver(() => {
      scheduleFit();
    });
    obs.observe(el);

    const onWheel = (ev: WheelEvent) => {
      if (disposed) return;
      if (!(ev.target instanceof Node)) return;
      if (!term.element || !term.element.contains(ev.target)) return;
      const viewport = term.element.querySelector<HTMLElement>(".xterm-viewport");
      if (!viewport) return;
      const viewportScrollable = viewport.scrollHeight > viewport.clientHeight + 1;
      const hasScrollback = term.buffer.active.baseY > 0;
      if (viewportScrollable || !hasScrollback) return;
      const direction = ev.deltaY > 0 ? 1 : -1;
      const magnitude = Math.max(1, Math.min(12, Math.round(Math.abs(ev.deltaY) / 32)));
      try {
        term.scrollLines(direction * magnitude);
        ev.preventDefault();
      } catch {
        // ignore
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });

    const intObs = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          requestAnimationFrame(() => scheduleFit(true));
        }
      }
    });
    intObs.observe(el);

    const onVisibilityChange = () => {
      if (disposed || document.hidden) return;
      requestAnimationFrame(() => scheduleFit(true));
    };
    const onWindowFocus = () => {
      if (disposed) return;
      requestAnimationFrame(() => scheduleFit(true));
    };
    const onWindowResize = () => {
      if (disposed) return;
      requestAnimationFrame(() => scheduleFit(true));
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("resize", onWindowResize);
    window.visualViewport?.addEventListener("resize", onWindowResize);

    const mutObs = new MutationObserver(() => {
      if (disposed) return;
      requestAnimationFrame(() => scheduleFit(true));
    });

    let ancestor: HTMLElement | null = el.parentElement;
    for (let depth = 0; depth < 4 && ancestor; depth++) {
      mutObs.observe(ancestor, { attributes: true, attributeFilter: ["class", "style"] });
      ancestor = ancestor.parentElement;
    }

    const setupDprListener = () => {
      teardownDprListener?.();
      const query = `(resolution: ${window.devicePixelRatio}dppx)`;
      const media = window.matchMedia(query);
      const onDprChange = () => {
        if (disposed) return;
        setupDprListener();
        scheduleFit(true);
      };
      if (typeof media.addEventListener === "function") {
        media.addEventListener("change", onDprChange);
        teardownDprListener = () => media.removeEventListener("change", onDprChange);
        return;
      }
      const legacyMedia = media as MediaQueryList & {
        addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
        removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
      };
      legacyMedia.addListener?.(onDprChange);
      teardownDprListener = () => legacyMedia.removeListener?.(onDprChange);
    };
    setupDprListener();

    const fontsReady = document.fonts?.ready;
    if (fontsReady) {
      fontsReady
        .then(() => {
          if (disposed) return;
          requestAnimationFrame(() => scheduleFit(true));
        })
        .catch(() => {});
    }

    return () => {
      disposed = true;
      if (fitRafId != null) cancelAnimationFrame(fitRafId);
      if (settleTimer1 != null) clearTimeout(settleTimer1);
      if (settleTimer2 != null) clearTimeout(settleTimer2);
      clearTimeout(hydrateTimer);
      if (hydrateRetryTimer != null) clearTimeout(hydrateRetryTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("resize", onWindowResize);
      window.visualViewport?.removeEventListener("resize", onWindowResize);
      el.removeEventListener("wheel", onWheel);
      try { unsubData(); unsubExit(); } catch { /* ignore */ }
      try { dataSub.dispose(); } catch { /* ignore */ }
      try { obs.disconnect(); } catch { /* ignore */ }
      try { intObs.disconnect(); } catch { /* ignore */ }
      try { mutObs.disconnect(); } catch { /* ignore */ }
      teardownDprListener?.();
      try { term.dispose(); } catch { /* ignore */ }
      termRef.current = null;
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
        "relative h-full min-h-0 min-w-0 w-full overflow-hidden rounded-xl bg-muted/70 shadow-card",
        className
      )}
    >
      <div ref={containerRef} className="ade-terminal-host h-full w-full" />
      {exited != null ? (
        <div className="pointer-events-none absolute bottom-2 right-2 rounded-lg bg-bg/90 shadow-card px-2 py-1 text-[11px] text-muted-fg">
          exited {exited}
        </div>
      ) : null}
    </div>
  );
}
