import "./browserMock"; // Must be first — stubs window.ade when outside Electron
import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./components/app/App";
import { RendererErrorBoundary } from "./components/app/RendererErrorBoundary";

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
  console.error(`renderer.unhandled_rejection ${JSON.stringify({
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack ?? null : null,
    route: window.location.hash || window.location.pathname,
  })}`);
});

let rendererWatchdogLastTick = performance.now();
window.setInterval(() => {
  const now = performance.now();
  const driftMs = now - rendererWatchdogLastTick - 1000;
  rendererWatchdogLastTick = now;
  if (driftMs < 1500) return;
  console.warn(`renderer.event_loop_stall ${JSON.stringify({
    driftMs: Math.round(driftMs),
    route: window.location.hash || window.location.pathname,
    visibilityState: document.visibilityState,
    memory: readRendererMemory(),
  })}`);
}, 1000);

createRoot(document.getElementById("root")!).render(
  <RootWrapper>
    <RendererErrorBoundary>
      <App />
    </RendererErrorBoundary>
  </RootWrapper>
);
