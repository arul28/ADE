/**
 * The surface router.
 *
 * `surfaceId` is the host's word for which manifest surface this guest draws.
 * Unknown ids fall through to commits rather than to an error page: a host
 * that grew a placement this build does not know should still show the reader
 * their history.
 *
 * There is ONE surface, because the compiled product was one `/history` route
 * with a Commits / Activity toggle in its toolbar. A second `activity` webview
 * made the same page reachable at two addresses with two `ui-state` rows and
 * two rail entries, which is a second History rather than a shortcut into the
 * one there is. The toggle is the way to Activity, as it always was; the
 * `activity` PANEL still publishes for iOS and the terminal, which draw no
 * page.
 *
 * `commits` keeps its id from before the page tier — a tab badge is addressed
 * by `"<pluginId>/<surfaceId>"`, so renaming it would silently orphan every
 * badge and deeplink pointing at the old one.
 */

import React from "react";

import type { PluginWebviewContext } from "./bridge";
import { CommitsEntry } from "./entries/CommitsEntry";

export const PAGE_SURFACE_IDS = ["commits"] as const;

export type PageSurfaceId = (typeof PAGE_SURFACE_IDS)[number];

export function PageRouter({ context }: { context: PluginWebviewContext }): React.ReactElement {
  return <CommitsEntry context={context} />;
}
