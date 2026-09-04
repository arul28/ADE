/**
 * The `runs` surface — the rail tab, and the command palette's "Review runs".
 *
 * One entry for both, because they are one page: the manifest's `runs` surface
 * is what the rail item and the palette action both name, so a reader who opens
 * Review either way sees the same runs and the same detail. There is no
 * Work-rail pane here and there never was one in the compiled product — see
 * PARITY.md's Placements table.
 */

import React from "react";

import type { PluginWebviewContext } from "../bridge";
import { ReviewRunsBrowser } from "../components/ReviewRunsBrowser";

export function RunsEntry({ context }: { context: PluginWebviewContext }): React.ReactElement {
  return <ReviewRunsBrowser context={context} />;
}
