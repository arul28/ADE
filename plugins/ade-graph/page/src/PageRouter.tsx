/**
 * The surface router.
 *
 * `surfaceId` is the host's word for which manifest surface this guest draws.
 * Unknown ids fall through to the canvas rather than to an error page: a host
 * that grew a placement this build does not know should still show the reader
 * their graph.
 *
 * `graph` keeps its id from before the page tier — a tab badge is addressed by
 * `"<pluginId>/<surfaceId>"`, so renaming it would silently orphan every badge
 * and deeplink pointing at the old one.
 */

import React from "react";

import type { PluginWebviewContext } from "./bridge";
import { WorkspaceGraph } from "./components/WorkspaceGraph";

export const PAGE_SURFACE_IDS = ["graph", "lane"] as const;

export type PageSurfaceId = (typeof PAGE_SURFACE_IDS)[number];

export function PageRouter({ context }: { context: PluginWebviewContext }): React.ReactElement {
  switch (context.surfaceId) {
    // The lane popover opens the same canvas focused on one lane. It is a
    // separate SURFACE because the host sizes an anchored placement from the
    // manifest, not a separate page: the focus comes from the context, which is
    // exactly how a deeplink into the tab focuses a lane too.
    case "lane":
    case "graph":
    default:
      return <WorkspaceGraph context={context} />;
  }
}
