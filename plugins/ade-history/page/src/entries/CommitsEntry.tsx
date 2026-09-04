/**
 * The `commits` surface — the rail tab, the Work-rail pane, and the palette
 * "History commits" row.
 *
 * One entry for all three, because they are one page: the manifest's `commits`
 * surface is the rail tab, and both the pane socket and the palette socket
 * name the same `webviewSurfaceId`, so a reader who opens History from the
 * rail and a reader who opens it beside their chat see the same DAG.
 */

import React from "react";

import type { PluginWebviewContext } from "../bridge";
import { HistoryPage } from "../history/HistoryPage";

export function CommitsEntry({ context }: { context: PluginWebviewContext }): React.ReactElement {
  return <HistoryPage context={context} />;
}
