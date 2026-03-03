import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { cn } from "../ui/cn";
import { useAppStore, type ThemeId } from "../../state/appStore";

type XtermTheme = NonNullable<ConstructorParameters<typeof Terminal>[0]>["theme"];
type TerminalRendererMode = "webgl" | "canvas" | "dom";

export type TerminalHealthCounters = {
  fitFailures: number;
  zeroDimFits: number;
  rendererFallbacks: number;
  droppedChunks: number;
};

type RuntimeSnapshot = {
  exitCode: number | null;
  renderer: TerminalRendererMode;
  health: TerminalHealthCounters;
};

type RuntimeListener = (snapshot: RuntimeSnapshot) => void;

type CachedRuntime = {
  key: string;
  ptyId: string;
  sessionId: string;
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  opened: boolean;
  disposed: boolean;
  refs: number;
  listeners: Set<RuntimeListener>;
  exitCode: number | null;
  renderer: TerminalRendererMode;
  rendererAddon: { dispose: () => void } | null;
  health: TerminalHealthCounters;
  lastDims: { cols: number; rows: number } | null;
  pendingForceResize: boolean;
  fitRafId: number | null;
  settleTimer1: ReturnType<typeof setTimeout> | null;
  settleTimer2: ReturnType<typeof setTimeout> | null;
  hydrateTimer: ReturnType<typeof setTimeout> | null;
  hydrateRetryTimer: ReturnType<typeof setTimeout> | null;
  hasFittedOnce: boolean;
  hydrationStarted: boolean;
  hydrationCompleted: boolean;
  pendingHydrationChunks: string[];
  pendingHydrationBytes: number;
  frameWriteChunks: string[];
  frameWriteBytes: number;
  flushRafId: number | null;
  disposeTimer: ReturnType<typeof setTimeout> | null;
  lastFitSafetyAt: number;
  ptyDataUnsub: (() => void) | null;
  ptyExitUnsub: (() => void) | null;
  termDataSub: { dispose: () => void } | null;
  rendererInitStarted: boolean;
};

const HYDRATE_TAIL_BYTES = 240_000;
const MAX_PENDING_HYDRATION_BYTES = 400_000;
const MAX_FRAME_WRITE_BYTES = 450_000;
const LIVE_RUNTIME_KEEPALIVE_MS = 90_000;
const EXITED_RUNTIME_KEEPALIVE_MS = 8_000;

const runtimeCache = new Map<string, CachedRuntime>();
let parkedRoot: HTMLDivElement | null = null;

const terminalThemes: Record<"light" | "dark", XtermTheme> = {
  light: {
    background: "#F2F0ED",
    foreground: "#1C1917",
    cursor: "#C22323",
    cursorAccent: "#FDFBF7",
    selectionBackground: "rgba(194, 35, 35, 0.16)"
  },
  dark: {
    background: "#0c0e16",
    foreground: "#EDEDED",
    cursor: "#F59E0B",
    cursorAccent: "#0c0e16",
    selectionBackground: "rgba(245, 158, 11, 0.26)"
  }
};

function isDarkTheme(theme: ThemeId): boolean {
  return theme === "dark";
}

function cloneHealth(health: TerminalHealthCounters): TerminalHealthCounters {
  return {
    fitFailures: health.fitFailures,
    zeroDimFits: health.zeroDimFits,
    rendererFallbacks: health.rendererFallbacks,
    droppedChunks: health.droppedChunks
  };
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

function ensureParkedRoot(): HTMLDivElement {
  if (parkedRoot && parkedRoot.isConnected) return parkedRoot;
  const next = document.createElement("div");
  next.setAttribute("data-ade-terminal-parking", "true");
  next.style.position = "fixed";
  next.style.width = "0";
  next.style.height = "0";
  next.style.overflow = "hidden";
  next.style.opacity = "0";
  next.style.pointerEvents = "none";
  next.style.left = "0";
  next.style.top = "0";
  document.body.appendChild(next);
  parkedRoot = next;
  return next;
}

function notifyRuntime(runtime: CachedRuntime) {
  const snapshot: RuntimeSnapshot = {
    exitCode: runtime.exitCode,
    renderer: runtime.renderer,
    health: cloneHealth(runtime.health)
  };
  for (const listener of runtime.listeners) {
    try {
      listener(snapshot);
    } catch {
      // ignore listener errors
    }
  }
}

function incrementHealth(runtime: CachedRuntime, key: keyof TerminalHealthCounters) {
  runtime.health[key] += 1;
  notifyRuntime(runtime);
}

function clearDisposeTimer(runtime: CachedRuntime) {
  if (!runtime.disposeTimer) return;
  clearTimeout(runtime.disposeTimer);
  runtime.disposeTimer = null;
}

function parkRuntime(runtime: CachedRuntime) {
  const parking = ensureParkedRoot();
  if (runtime.host.parentElement !== parking) {
    parking.appendChild(runtime.host);
  }
}

function teardownRuntime(runtime: CachedRuntime) {
  runtime.disposed = true;
  clearDisposeTimer(runtime);
  if (runtime.fitRafId != null) cancelAnimationFrame(runtime.fitRafId);
  if (runtime.flushRafId != null) cancelAnimationFrame(runtime.flushRafId);
  if (runtime.settleTimer1) clearTimeout(runtime.settleTimer1);
  if (runtime.settleTimer2) clearTimeout(runtime.settleTimer2);
  if (runtime.hydrateTimer) clearTimeout(runtime.hydrateTimer);
  if (runtime.hydrateRetryTimer) clearTimeout(runtime.hydrateRetryTimer);

  try {
    runtime.ptyDataUnsub?.();
  } catch {
    // ignore
  }
  try {
    runtime.ptyExitUnsub?.();
  } catch {
    // ignore
  }
  try {
    runtime.termDataSub?.dispose();
  } catch {
    // ignore
  }
  try {
    runtime.rendererAddon?.dispose();
  } catch {
    // ignore
  }
  try {
    runtime.term.dispose();
  } catch {
    // ignore
  }
  try {
    runtime.host.remove();
  } catch {
    // ignore
  }

  runtimeCache.delete(runtime.key);
}

function scheduleRuntimeDispose(runtime: CachedRuntime, delayMs: number) {
  clearDisposeTimer(runtime);
  runtime.disposeTimer = setTimeout(() => {
    if (runtime.refs > 0) return;
    teardownRuntime(runtime);
  }, delayMs);
}

function ensureOpen(runtime: CachedRuntime): boolean {
  if (runtime.disposed) return false;
  if (runtime.term.element) return true;
  if (!runtime.host.isConnected) return false;
  if (runtime.host.clientWidth <= 0 || runtime.host.clientHeight <= 0) return false;
  try {
    runtime.term.open(runtime.host);
    runtime.opened = true;
  } catch {
    return false;
  }
  return true;
}

function doFit(runtime: CachedRuntime, forcePtyResize = false) {
  if (runtime.disposed) return;
  if (!ensureOpen(runtime)) return;
  if (!runtime.host.isConnected || runtime.host.clientWidth <= 0 || runtime.host.clientHeight <= 0) return;

  try {
    runtime.fit.fit();
  } catch {
    incrementHealth(runtime, "fitFailures");
    return;
  }

  const next = { cols: runtime.term.cols, rows: runtime.term.rows };
  if (!Number.isFinite(next.cols) || !Number.isFinite(next.rows) || next.cols <= 0 || next.rows <= 0) {
    incrementHealth(runtime, "zeroDimFits");
    return;
  }

  runtime.hasFittedOnce = true;
  const prev = runtime.lastDims;
  if (!prev || prev.cols !== next.cols || prev.rows !== next.rows || forcePtyResize) {
    runtime.lastDims = next;
    window.ade.pty.resize({ ptyId: runtime.ptyId, cols: next.cols, rows: next.rows }).catch(() => {});
  }

  // Safety pass for right-edge clipping and stale col counts.
  const viewport = runtime.host.querySelector<HTMLElement>(".xterm-viewport");
  const screen = runtime.host.querySelector<HTMLElement>(".xterm-screen");
  if (viewport && screen) {
    const slack = viewport.clientWidth - screen.clientWidth;
    if (slack > 2 && Date.now() - runtime.lastFitSafetyAt > 120) {
      runtime.lastFitSafetyAt = Date.now();
      runtime.pendingForceResize = true;
      if (runtime.fitRafId == null) {
        runtime.fitRafId = requestAnimationFrame(() => {
          runtime.fitRafId = null;
          const force = runtime.pendingForceResize;
          runtime.pendingForceResize = false;
          doFit(runtime, force);
        });
      }
    }
  }

  try {
    runtime.term.refresh(0, Math.max(0, runtime.term.rows - 1));
  } catch {
    // ignore refresh failures after dispose
  }
}

function scheduleFit(runtime: CachedRuntime, forcePtyResize = false) {
  if (runtime.disposed) return;
  runtime.pendingForceResize = runtime.pendingForceResize || forcePtyResize;
  if (runtime.fitRafId != null) return;
  runtime.fitRafId = requestAnimationFrame(() => {
    runtime.fitRafId = null;
    const shouldForce = runtime.pendingForceResize;
    runtime.pendingForceResize = false;
    doFit(runtime, shouldForce);
  });
}

function enqueueFrameWrite(runtime: CachedRuntime, chunk: string) {
  if (!chunk) return;
  runtime.frameWriteChunks.push(chunk);
  runtime.frameWriteBytes += chunk.length;
  while (runtime.frameWriteBytes > MAX_FRAME_WRITE_BYTES && runtime.frameWriteChunks.length > 1) {
    const dropped = runtime.frameWriteChunks.shift();
    runtime.frameWriteBytes -= dropped?.length ?? 0;
    incrementHealth(runtime, "droppedChunks");
  }
  if (runtime.flushRafId != null) return;
  runtime.flushRafId = requestAnimationFrame(() => {
    runtime.flushRafId = null;
    if (runtime.disposed) return;
    if (runtime.frameWriteChunks.length === 0) return;
    const merged = runtime.frameWriteChunks.join("");
    runtime.frameWriteChunks.length = 0;
    runtime.frameWriteBytes = 0;
    try {
      runtime.term.write(merged);
    } catch {
      // ignore write errors after disposal
    }
  });
}

function flushHydrationData(runtime: CachedRuntime, tail: string) {
  const stabilizedTail = trimToLikelyTerminalFrameBoundary(tail);
  const pending = runtime.pendingHydrationChunks.join("");
  runtime.pendingHydrationChunks.length = 0;
  runtime.pendingHydrationBytes = 0;

  const overlap = computeSuffixPrefixOverlap(stabilizedTail, pending);
  let appendPending = true;
  if (pending.length >= 8_000 && overlap < 64) {
    const probe = pending.slice(0, Math.min(512, pending.length));
    if (probe.length >= 64 && stabilizedTail.lastIndexOf(probe) !== -1) {
      appendPending = false;
    }
  }

  const merged = appendPending ? `${stabilizedTail}${pending.slice(overlap)}` : stabilizedTail;
  if (merged.length) {
    try {
      runtime.term.write(merged);
      requestAnimationFrame(() => {
        try {
          runtime.term.refresh(0, Math.max(0, runtime.term.rows - 1));
          runtime.term.scrollToBottom();
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore
    }
  }
}

function startHydration(runtime: CachedRuntime) {
  if (runtime.hydrationStarted || runtime.disposed) return;
  runtime.hydrationStarted = true;

  const hydrateTranscript = () => {
    window.ade.sessions
      .readTranscriptTail({ sessionId: runtime.sessionId, maxBytes: HYDRATE_TAIL_BYTES, raw: true })
      .then((text) => {
        if (runtime.disposed) return;
        flushHydrationData(runtime, text);
        runtime.hydrationCompleted = true;
        scheduleFit(runtime, true);
      })
      .catch(() => {
        if (runtime.disposed) return;
        flushHydrationData(runtime, "");
        runtime.hydrationCompleted = true;
        scheduleFit(runtime, true);
      });
  };

  const waitForFitThenHydrate = (attempt: number) => {
    if (runtime.disposed) return;
    if (runtime.hasFittedOnce || attempt >= 20) {
      hydrateTranscript();
      return;
    }
    runtime.hydrateRetryTimer = setTimeout(() => {
      runtime.hydrateRetryTimer = null;
      waitForFitThenHydrate(attempt + 1);
    }, 60);
  };

  runtime.hydrateTimer = setTimeout(() => {
    runtime.hydrateTimer = null;
    waitForFitThenHydrate(0);
  }, 120);
}

async function loadAddonCtor(moduleName: string, exportName: string): Promise<any | null> {
  try {
    const mod = await import(/* @vite-ignore */ moduleName);
    return (mod as any)?.[exportName] ?? null;
  } catch {
    return null;
  }
}

async function setRenderer(runtime: CachedRuntime, mode: TerminalRendererMode): Promise<boolean> {
  if (runtime.disposed) return false;

  if (mode === "dom") {
    try {
      runtime.rendererAddon?.dispose();
    } catch {
      // ignore
    }
    runtime.rendererAddon = null;
    runtime.renderer = "dom";
    notifyRuntime(runtime);
    return true;
  }

  const moduleName = mode === "webgl" ? "@xterm/addon-webgl" : "@xterm/addon-canvas";
  const exportName = mode === "webgl" ? "WebglAddon" : "CanvasAddon";
  const Ctor = await loadAddonCtor(moduleName, exportName);
  if (!Ctor) return false;

  try {
    const addon = new Ctor();
    runtime.term.loadAddon(addon);
    try {
      runtime.rendererAddon?.dispose();
    } catch {
      // ignore
    }
    runtime.rendererAddon = addon as { dispose: () => void };
    runtime.renderer = mode;

    if (mode === "webgl") {
      const maybeOnContextLoss = (addon as { onContextLoss?: (cb: () => void) => void }).onContextLoss;
      if (typeof maybeOnContextLoss === "function") {
        maybeOnContextLoss(() => {
          incrementHealth(runtime, "rendererFallbacks");
          void setRenderer(runtime, "canvas").then((ok) => {
            if (!ok) {
              void setRenderer(runtime, "dom");
            }
          });
        });
      }
    }

    notifyRuntime(runtime);
    return true;
  } catch {
    return false;
  }
}

async function initRendererChain(runtime: CachedRuntime) {
  if (runtime.rendererInitStarted || runtime.disposed) return;
  runtime.rendererInitStarted = true;

  const webgl = await setRenderer(runtime, "webgl");
  if (webgl) return;
  const canvas = await setRenderer(runtime, "canvas");
  if (canvas) {
    incrementHealth(runtime, "rendererFallbacks");
    return;
  }
  incrementHealth(runtime, "rendererFallbacks");
  await setRenderer(runtime, "dom");
}

function createRuntime(args: { ptyId: string; sessionId: string; theme: XtermTheme }): CachedRuntime {
  const host = document.createElement("div");
  host.className = "h-full w-full m-0 p-0 border-0 overflow-hidden";

  const term = new Terminal({
    convertEol: true,
    cursorBlink: true,
    scrollback: 6000,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.2,
    theme: args.theme
  });

  const fit = new FitAddon();
  term.loadAddon(fit);

  const runtime: CachedRuntime = {
    key: args.sessionId,
    ptyId: args.ptyId,
    sessionId: args.sessionId,
    term,
    fit,
    host,
    opened: false,
    disposed: false,
    refs: 0,
    listeners: new Set(),
    exitCode: null,
    renderer: "dom",
    rendererAddon: null,
    health: { fitFailures: 0, zeroDimFits: 0, rendererFallbacks: 0, droppedChunks: 0 },
    lastDims: null,
    pendingForceResize: false,
    fitRafId: null,
    settleTimer1: null,
    settleTimer2: null,
    hydrateTimer: null,
    hydrateRetryTimer: null,
    hasFittedOnce: false,
    hydrationStarted: false,
    hydrationCompleted: false,
    pendingHydrationChunks: [],
    pendingHydrationBytes: 0,
    frameWriteChunks: [],
    frameWriteBytes: 0,
    flushRafId: null,
    disposeTimer: null,
    lastFitSafetyAt: 0,
    ptyDataUnsub: null,
    ptyExitUnsub: null,
    termDataSub: null,
    rendererInitStarted: false
  };

  term.attachCustomKeyEventHandler((ev) => {
    const isMac = navigator.platform.toLowerCase().includes("mac");
    const mod = isMac ? ev.metaKey : ev.ctrlKey;
    const key = ev.key.toLowerCase();

    if (ev.type !== "keydown") return true;

    if (mod && key === "v") {
      navigator.clipboard
        .readText()
        .then((text) => {
          if (runtime.disposed) return;
          return window.ade.pty.write({ ptyId: runtime.ptyId, data: text });
        })
        .catch(() => {});
      return false;
    }

    if (mod && key === "c") {
      const selection = term.getSelection();
      if (selection) {
        navigator.clipboard.writeText(selection).catch(() => {});
        return false;
      }
      return true;
    }

    // Shift+Enter should insert a newline in tools like Claude/Codex prompts.
    if (ev.shiftKey && ev.key === "Enter") {
      ev.preventDefault();
      window.ade.pty.write({ ptyId: runtime.ptyId, data: "\n" }).catch(() => {});
      return false;
    }

    if (isMac && ev.altKey && ev.key === "Backspace") {
      ev.preventDefault();
      window.ade.pty.write({ ptyId: runtime.ptyId, data: "\x1b\x7f" }).catch(() => {});
      return false;
    }

    if (isMac && ev.metaKey && ev.key === "Backspace") {
      ev.preventDefault();
      window.ade.pty.write({ ptyId: runtime.ptyId, data: "\x15" }).catch(() => {});
      return false;
    }

    return true;
  });

  runtime.termDataSub = term.onData((data) => {
    if (runtime.disposed) return;
    window.ade.pty.write({ ptyId: runtime.ptyId, data }).catch(() => {});
  });

  runtime.ptyDataUnsub = window.ade.pty.onData((ev) => {
    if (runtime.disposed) return;
    if (ev.ptyId !== runtime.ptyId) return;

    if (!runtime.hydrationCompleted) {
      runtime.pendingHydrationChunks.push(ev.data);
      runtime.pendingHydrationBytes += ev.data.length;
      while (runtime.pendingHydrationBytes > MAX_PENDING_HYDRATION_BYTES && runtime.pendingHydrationChunks.length > 1) {
        const dropped = runtime.pendingHydrationChunks.shift();
        runtime.pendingHydrationBytes -= dropped?.length ?? 0;
        incrementHealth(runtime, "droppedChunks");
      }
      return;
    }

    enqueueFrameWrite(runtime, ev.data);
  });

  runtime.ptyExitUnsub = window.ade.pty.onExit((ev) => {
    if (runtime.disposed) return;
    if (ev.ptyId !== runtime.ptyId) return;
    runtime.exitCode = ev.exitCode ?? 0;
    notifyRuntime(runtime);
    if (runtime.refs === 0) {
      scheduleRuntimeDispose(runtime, EXITED_RUNTIME_KEEPALIVE_MS);
    }
  });

  void initRendererChain(runtime);

  return runtime;
}

function ensureRuntime(args: { ptyId: string; sessionId: string; theme: XtermTheme }): CachedRuntime {
  const existing = runtimeCache.get(args.sessionId);
  if (existing && !existing.disposed) {
    if (existing.ptyId === args.ptyId) {
      clearDisposeTimer(existing);
      return existing;
    }
    teardownRuntime(existing);
  }

  const runtime = createRuntime(args);
  runtimeCache.set(args.sessionId, runtime);
  return runtime;
}

export function getTerminalRuntimeHealth(sessionId: string): TerminalHealthCounters | null {
  const runtime = runtimeCache.get(sessionId);
  if (!runtime || runtime.disposed) return null;
  return cloneHealth(runtime.health);
}

export function TerminalView({ ptyId, sessionId, className }: { ptyId: string; sessionId: string; className?: string }) {
  const appTheme = useAppStore((s) => s.theme);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<CachedRuntime | null>(null);
  const [exited, setExited] = useState<number | null>(null);

  const termTheme = useMemo(() => terminalThemes[isDarkTheme(appTheme) ? "dark" : "light"], [appTheme]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const runtime = ensureRuntime({ ptyId, sessionId, theme: termTheme });
    runtimeRef.current = runtime;
    runtime.refs += 1;
    clearDisposeTimer(runtime);

    const onRuntimeSnapshot: RuntimeListener = (snapshot) => {
      setExited(snapshot.exitCode);
    };
    runtime.listeners.add(onRuntimeSnapshot);
    setExited(runtime.exitCode);

    if (runtime.host.parentElement !== el) {
      el.replaceChildren(runtime.host);
    }

    const schedule = (forceResize = false) => scheduleFit(runtime, forceResize);

    schedule(true);
    runtime.settleTimer1 = setTimeout(() => {
      runtime.settleTimer1 = null;
      schedule(true);
    }, 120);
    runtime.settleTimer2 = setTimeout(() => {
      runtime.settleTimer2 = null;
      schedule(true);
    }, 320);

    startHydration(runtime);

    const obs = new ResizeObserver(() => {
      schedule();
    });
    obs.observe(el);

    const onWheel = (ev: WheelEvent) => {
      if (runtime.disposed) return;
      if (!(ev.target instanceof Node)) return;
      if (!runtime.term.element || !runtime.term.element.contains(ev.target)) return;
      const viewport = runtime.term.element.querySelector<HTMLElement>(".xterm-viewport");
      if (!viewport) return;
      const viewportScrollable = viewport.scrollHeight > viewport.clientHeight + 1;
      const hasScrollback = runtime.term.buffer.active.baseY > 0;
      if (viewportScrollable || !hasScrollback) return;
      const direction = ev.deltaY > 0 ? 1 : -1;
      const magnitude = Math.max(1, Math.min(12, Math.round(Math.abs(ev.deltaY) / 32)));
      try {
        runtime.term.scrollLines(direction * magnitude);
        ev.preventDefault();
      } catch {
        // ignore
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });

    const intObs = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          requestAnimationFrame(() => schedule(true));
        }
      }
    });
    intObs.observe(el);

    const onVisibilityChange = () => {
      if (document.hidden) return;
      requestAnimationFrame(() => schedule(true));
    };
    const onWindowFocus = () => {
      requestAnimationFrame(() => schedule(true));
    };
    const onWindowResize = () => {
      requestAnimationFrame(() => schedule(true));
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("resize", onWindowResize);
    window.visualViewport?.addEventListener("resize", onWindowResize);

    const mutObs = new MutationObserver(() => {
      requestAnimationFrame(() => schedule(true));
    });

    let ancestor: HTMLElement | null = el.parentElement;
    for (let depth = 0; depth < 4 && ancestor; depth++) {
      mutObs.observe(ancestor, { attributes: true, attributeFilter: ["class", "style"] });
      ancestor = ancestor.parentElement;
    }

    const setupDprListener = () => {
      let cleanup: (() => void) | null = null;
      const query = `(resolution: ${window.devicePixelRatio}dppx)`;
      const media = window.matchMedia(query);
      const onDprChange = () => {
        if (cleanup) cleanup();
        requestAnimationFrame(() => schedule(true));
      };

      if (typeof media.addEventListener === "function") {
        media.addEventListener("change", onDprChange);
        cleanup = () => media.removeEventListener("change", onDprChange);
      } else {
        const legacy = media as MediaQueryList & {
          addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
          removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
        };
        legacy.addListener?.(onDprChange);
        cleanup = () => legacy.removeListener?.(onDprChange);
      }
      return cleanup;
    };
    const teardownDpr = setupDprListener();

    const fontsReady = document.fonts?.ready;
    if (fontsReady) {
      fontsReady
        .then(() => {
          requestAnimationFrame(() => schedule(true));
        })
        .catch(() => {});
    }

    return () => {
      runtime.listeners.delete(onRuntimeSnapshot);

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
      try {
        mutObs.disconnect();
      } catch {
        // ignore
      }
      try {
        teardownDpr?.();
      } catch {
        // ignore
      }

      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("resize", onWindowResize);
      window.visualViewport?.removeEventListener("resize", onWindowResize);
      el.removeEventListener("wheel", onWheel);

      if (runtime.host.parentElement === el) {
        parkRuntime(runtime);
      }

      runtime.refs = Math.max(0, runtime.refs - 1);
      if (runtime.refs === 0) {
        scheduleRuntimeDispose(runtime, runtime.exitCode == null ? LIVE_RUNTIME_KEEPALIVE_MS : EXITED_RUNTIME_KEEPALIVE_MS);
      }
    };
  }, [ptyId, sessionId]);

  useEffect(() => {
    const runtime = runtimeRef.current ?? runtimeCache.get(sessionId);
    if (!runtime || runtime.disposed) return;
    const id = requestAnimationFrame(() => {
      try {
        runtime.term.options.theme = termTheme ? { ...termTheme } : undefined;
      } catch {
        // ignore theme updates when disposed
      }
    });
    return () => cancelAnimationFrame(id);
  }, [sessionId, termTheme]);

  return (
    <div
      className={cn(
        "relative h-full min-h-0 min-w-0 w-full overflow-hidden rounded-xl bg-surface-recessed",
        exited == null && "ade-terminal-active-glow shadow-[0_0_12px_-4px_rgba(34,197,94,0.2)]",
        exited != null && "shadow-card",
        className
      )}
    >
      <div ref={containerRef} className="ade-terminal-host h-full w-full m-0 p-0 border-0 overflow-hidden" />
      {exited != null ? (
        <div className="pointer-events-none absolute bottom-2 right-2 rounded-lg border border-border/15 bg-card backdrop-blur-sm shadow-card px-2 py-1 text-[11px] text-muted-fg">
          exited {exited}
        </div>
      ) : null}
    </div>
  );
}
