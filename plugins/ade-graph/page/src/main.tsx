/**
 * One page, two placements.
 *
 * The manifest declares a `webview` surface per placement and both of them load
 * THIS file. Which one draws is decided by the host's own injected `surfaceId` —
 * read through the bridge, never from a query the page could rewrite.
 *
 * The theme is painted before the tree mounts, so nothing flashes the wrong
 * scheme, and `data-ade-placement` lands on `<body>` so the stylesheet can size
 * a popover to its content and a tab to the viewport.
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
    document.body.dataset.adePlacement = context.placement ?? "tab";
    document.body.dataset.adeSurface = context.surfaceId ?? "graph";
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
