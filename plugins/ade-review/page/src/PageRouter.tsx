/**
 * The surface router.
 *
 * `surfaceId` is the host's word for which manifest surface this guest draws.
 * Unknown ids fall through to the runs browser rather than to an error page: a
 * host that grew a placement this build does not know should still show the
 * reader their review runs.
 */

import React from "react";

import type { PluginWebviewContext } from "./bridge";
import { LaunchEntry } from "./entries/LaunchEntry";
import { RunsEntry } from "./entries/RunsEntry";

export const PAGE_SURFACE_IDS = ["runs", "launch"] as const;

export type PageSurfaceId = (typeof PAGE_SURFACE_IDS)[number];

export function PageRouter({ context }: { context: PluginWebviewContext }): React.ReactElement {
  switch (context.surfaceId) {
    case "launch":
      return <LaunchEntry context={context} />;
    // `runs` is the rail tab, and it keeps that id from before the page tier: a
    // tab badge is addressed by `"<pluginId>/<surfaceId>"`, so renaming it would
    // silently orphan every badge and deeplink pointing at the old one.
    case "runs":
    default:
      return <RunsEntry context={context} />;
  }
}
