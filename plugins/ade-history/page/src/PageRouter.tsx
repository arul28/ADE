/**
 * The surface router.
 *
 * `surfaceId` is the host's word for which manifest surface this guest draws.
 * Unknown ids fall through to commits rather than to an error page: a host
 * that grew a placement this build does not know should still show the reader
 * their history.
 *
 * `commits` and `activity` keep their ids from before the page tier — a tab
 * badge is addressed by `"<pluginId>/<surfaceId>"`, so renaming either would
 * silently orphan every badge and deeplink pointing at the old one.
 *
 * Both surfaces draw the same History page. The compiled product was one
 * `/history` route with a Commits / Activity toggle; the two webviews exist so
 * the rail and the palette can open either initially. The toggle still works
 * in-page.
 */

import React from "react";

import type { PluginWebviewContext } from "./bridge";
import { ActivityEntry } from "./entries/ActivityEntry";
import { CommitsEntry } from "./entries/CommitsEntry";

export const PAGE_SURFACE_IDS = ["commits", "activity"] as const;

export type PageSurfaceId = (typeof PAGE_SURFACE_IDS)[number];

export function PageRouter({ context }: { context: PluginWebviewContext }): React.ReactElement {
  switch (context.surfaceId) {
    case "activity":
      return <ActivityEntry context={context} />;
    case "commits":
    default:
      return <CommitsEntry context={context} />;
  }
}
