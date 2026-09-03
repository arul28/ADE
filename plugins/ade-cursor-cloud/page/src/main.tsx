/**
 * One page, three placements.
 *
 * The manifest declares a `webview` surface per placement and every one of them
 * loads THIS file. Which of the three draws is decided by the host's own
 * injected `surfaceId` — read through the bridge, never from a query the page
 * could rewrite.
 *
 * The theme is painted before the tree mounts, so nothing flashes the wrong
 * scheme, and `data-ade-placement` lands on `<body>` so the stylesheet can size
 * a composer picker to its content and a tab to the viewport.
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
    document.body.dataset.adeSurface = context.surfaceId ?? "fleet";
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
