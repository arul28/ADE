/**
 * The surface router.
 *
 * `surfaceId` is the host's word for which manifest surface this guest draws.
 * It is read through the bridge, never from a query the page could rewrite, so
 * a composer popover cannot ask to be the fleet tab.
 *
 * Unknown ids fall through to the fleet rather than to an error page: a host
 * that grew a placement this build does not know should still show the reader
 * their cloud agents.
 */

import React from "react";

import type { PluginWebviewContext } from "./bridge";
import { AgentEntry } from "./entries/AgentEntry";
import { FleetEntry } from "./entries/FleetEntry";
import { LaunchEntry } from "./entries/LaunchEntry";

export const PAGE_SURFACE_IDS = ["fleet", "agent", "launch"] as const;

export type PageSurfaceId = (typeof PAGE_SURFACE_IDS)[number];

export function PageRouter({ context }: { context: PluginWebviewContext }): React.ReactElement {
  switch (context.surfaceId) {
    // The detail on its own, for a deeplink and for the chat header's press.
    case "agent":
      return <AgentEntry context={context} />;
    // The machine row's Advanced, drawn as a composer picker.
    case "launch":
      return <LaunchEntry context={context} />;
    // `fleet` is the rail tab, the Work-rail pane and the phone, and it keeps
    // that id: a tab badge is addressed by `"<pluginId>/<surfaceId>"`, so
    // renaming it would silently orphan every badge and deeplink pointing at
    // the old one.
    case "fleet":
    default:
      return <FleetEntry context={context} />;
  }
}
