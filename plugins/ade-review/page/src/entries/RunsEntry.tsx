/**
 * The `runs` surface — the rail tab and the Work-rail pane.
 *
 * One entry for both, because they are one page: the manifest's `runs` surface
 * is the rail tab, and the `work-rail-pane` socket names the same
 * `webviewSurfaceId`, so a reader who opens Review from the rail and a reader
 * who opens it beside their chat see the same runs and the same detail.
 */

import React from "react";

import type { PluginWebviewContext } from "../bridge";
import { ReviewRunsBrowser } from "../components/ReviewRunsBrowser";

export function RunsEntry({ context }: { context: PluginWebviewContext }): React.ReactElement {
  return <ReviewRunsBrowser context={context} />;
}
