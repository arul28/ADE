import "./browserMock"; // Must be first — stubs window.ade when outside Electron
import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import jetbrainsMonoUrl from "../../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url";
import geistVariableUrl from "../../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2?url";
import geistMonoVariableUrl from "../../node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2?url";
import { App } from "./components/app/App";
import { RendererErrorBoundary } from "./components/app/RendererErrorBoundary";
import { logRendererDebugEvent } from "./lib/debugLog";

(function injectFontFaces() {
  const style = document.createElement("style");
  style.dataset.adeFonts = "true";
  style.textContent = `
    @font-face {
      font-family: 'JetBrains Mono';
      src: url('${jetbrainsMonoUrl}') format('woff2');
      font-weight: 100 800;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: 'Geist';
      src: url('${geistVariableUrl}') format('woff2');
      font-weight: 100 900;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: 'Geist Mono';
      src: url('${geistMonoVariableUrl}') format('woff2');
      font-weight: 100 900;
      font-style: normal;
      font-display: swap;
    }
  `;
  document.head.appendChild(style);
})();

const RootWrapper = (window as any).__adeBrowserMock ? React.StrictMode : React.Fragment;

function readRendererMemory() {
  const perf = performance as Performance & {
    memory?: {
      usedJSHeapSize?: number;
      totalJSHeapSize?: number;
      jsHeapSizeLimit?: number;
    };
  };
  const memory = perf.memory;
  if (!memory) return null;
  return {
    usedMB: Math.round((memory.usedJSHeapSize ?? 0) / 1024 / 1024),
    totalMB: Math.round((memory.totalJSHeapSize ?? 0) / 1024 / 1024),
    limitMB: Math.round((memory.jsHeapSizeLimit ?? 0) / 1024 / 1024),
  };
}

window.addEventListener("error", (event) => {
  logRendererDebugEvent("renderer.window_error", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    stack: event.error instanceof Error ? event.error.stack ?? null : null,
    route: window.location.hash || window.location.pathname,
  });
  console.error(`renderer.window_error ${JSON.stringify({
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    stack: event.error instanceof Error ? event.error.stack ?? null : null,
    route: window.location.hash || window.location.pathname,
  })}`);
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  logRendererDebugEvent("renderer.unhandled_rejection", {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack ?? null : null,
    route: window.location.hash || window.location.pathname,
  });
  console.error(`renderer.unhandled_rejection ${JSON.stringify({
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack ?? null : null,
    route: window.location.hash || window.location.pathname,
  })}`);
});

let rendererWatchdogLastTick = performance.now();
let rendererWatchdogIntervalId: number | null = null;

function startWatchdog() {
  if (rendererWatchdogIntervalId !== null) return;
  rendererWatchdogLastTick = performance.now();
  rendererWatchdogIntervalId = window.setInterval(() => {
    const now = performance.now();
    const driftMs = now - rendererWatchdogLastTick - 1000;
    rendererWatchdogLastTick = now;
    if (driftMs < 1500) return;
    logRendererDebugEvent("renderer.event_loop_stall", {
      driftMs: Math.round(driftMs),
      route: window.location.hash || window.location.pathname,
      visibilityState: document.visibilityState,
      memory: readRendererMemory(),
    });
    console.warn(`renderer.event_loop_stall ${JSON.stringify({
      driftMs: Math.round(driftMs),
      route: window.location.hash || window.location.pathname,
      visibilityState: document.visibilityState,
      memory: readRendererMemory(),
    })}`);
  }, 1000);
}

function stopWatchdog() {
  if (rendererWatchdogIntervalId === null) return;
  window.clearInterval(rendererWatchdogIntervalId);
  rendererWatchdogIntervalId = null;
}

function handleVisibilityChange() {
  if (document.visibilityState === "visible") {
    startWatchdog();
  } else {
    stopWatchdog();
  }
}

document.addEventListener("visibilitychange", handleVisibilityChange);
window.addEventListener("beforeunload", () => {
  stopWatchdog();
  document.removeEventListener("visibilitychange", handleVisibilityChange);
});

if (document.visibilityState === "visible") {
  startWatchdog();
}

createRoot(document.getElementById("root")!).render(
  <RootWrapper>
    <RendererErrorBoundary>
      <App />
    </RendererErrorBoundary>
  </RootWrapper>
);
