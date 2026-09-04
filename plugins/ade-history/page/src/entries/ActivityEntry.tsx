/**
 * The `activity` surface — the palette "History activity" row.
 *
 * The compiled product was one `/history` route with a Commits / Activity
 * toggle. This surface exists so the palette can open the operations timeline
 * first; the toggle still works in-page, and both surfaces load this same
 * History page.
 */

import React from "react";

import type { PluginWebviewContext } from "../bridge";
import { HistoryPage } from "../history/HistoryPage";

export function ActivityEntry({ context }: { context: PluginWebviewContext }): React.ReactElement {
  return <HistoryPage context={context} />;
}
