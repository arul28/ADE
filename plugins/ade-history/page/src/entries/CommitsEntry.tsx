/**
 * The `commits` surface — History's one route.
 *
 * One entry, because there is one page: the rail tab draws it, and the palette
 * row navigates to that same tab rather than opening a copy of it in an
 * overlay. The Commits / Activity toggle inside the toolbar is how a reader
 * reaches the operation timeline, exactly as it was before the page tier.
 */

import React from "react";

import type { PluginWebviewContext } from "../bridge";
import { HistoryPage } from "../history/HistoryPage";

export function CommitsEntry({ context }: { context: PluginWebviewContext }): React.ReactElement {
  return <HistoryPage context={context} />;
}
