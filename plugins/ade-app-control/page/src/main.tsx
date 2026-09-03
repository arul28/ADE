/**
 * One page, one placement.
 *
 * The manifest declares a single `webview` surface and both the Work-rail pane
 * and the command-palette entry point at it through `webviewSurfaceId`. Which
 * surface draws is decided by the host's own injected `surfaceId` — read through
 * the bridge, never from a query the page could rewrite.
 *
 * The theme is painted before the tree mounts, so nothing flashes the wrong
 * scheme, and `data-ade-placement` lands on `<body>` so the stylesheet can give
 * a pane the app's ground while a popover keeps the host's.
 */

import React from "react";
import { createRoot } from "react-dom/client";

import "./styles/page.css";
import { pageContext } from "./bridge";
import { followHostTheme } from "./host/theme";
import { PageRouter } from "./PageRouter";

async function start(): Promise<void> {
  const context = pageContext();
  if (typeof document !== "undefined") {
    document.body.dataset.adePlacement = context.placement ?? "pane";
    document.body.dataset.adeSurface = context.surfaceId ?? "control";
  }

  await followHostTheme();

  const host = document.getElementById("root");
  if (!host) return;
  createRoot(host).render(
    <React.StrictMode>
      <PageRouter context={context} />
    </React.StrictMode>,
  );
}

void start();
