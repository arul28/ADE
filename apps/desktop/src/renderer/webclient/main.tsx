import React from "react";
import { createRoot } from "react-dom/client";
import "./gate.css";
import jetbrainsMonoUrl from "../../../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url";
import geistVariableUrl from "../../../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2?url";
import geistMonoVariableUrl from "../../../node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2?url";
import { AdeSyncClient, bindProjectHostRecoveryClient } from "./sync";
import { WebClientRoot } from "./shell/WebClientRoot";
import { installScrollingIndicator } from "../lib/scrollingIndicator";
import { installAnimationPhaseAlignment } from "../lib/animationPhaseAlignment";
import { isAdeUnavailableError } from "../lib/adeAvailability";
import { installStaleChunkReload, reloadForStaleChunk } from "../lib/staleChunkReload";

// Mark web-client mode before any renderer module loads, so desktop-only chrome
// (extra tabs, onboarding tour, native window controls, updater) hides cleanly.
window.__adeWebClient = true;

// window.ade must exist before any renderer module (loaded later by the App) is
// evaluated. Install a pending placeholder; the shell overwrites it with the
// sync-backed adapter's implementation once a machine + project are connected.
Object.defineProperty(window, "ade", {
  configurable: true,
  writable: true,
  value: { __adeWebClientPending: true },
});

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

// Default the palette to dark (the :root default) until the mounted App applies
// the user's persisted theme.
document.documentElement.setAttribute("data-theme", document.documentElement.getAttribute("data-theme") ?? "dark");

const client = new AdeSyncClient();
// Single-client boot: this one client is always the machine on screen.
bindProjectHostRecoveryClient(client);

// Scrollbars show only while you scroll the region under the pointer.
installScrollingIndicator();
installAnimationPhaseAlignment();

// A fire-and-forget call to a desktop-only `window.ade` member rejects with
// AdeUnavailableError. Nobody is waiting on it, so it is not an error worth a
// console line or a crash report.
window.addEventListener("unhandledrejection", (event) => {
  if (isAdeUnavailableError(event.reason)) event.preventDefault();
  // A chunk a deploy removed: reload once for the new build.
  else if (reloadForStaleChunk(event.reason)) event.preventDefault();
});
installStaleChunkReload();

createRoot(document.getElementById("root") as HTMLElement).render(
  <WebClientRoot client={client} />,
);

// Error tracking after the first paint, as its own chunk (see ./sentry.ts).
const startSentry = () => {
  void import("./sentry").then((module) => module.initWebClientSentry()).catch(() => undefined);
};
if ("requestIdleCallback" in window) window.requestIdleCallback(startSentry, { timeout: 3_000 });
else setTimeout(startSentry, 1_000);
