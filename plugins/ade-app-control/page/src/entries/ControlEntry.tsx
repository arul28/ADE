/**
 * The `control` surface: the whole pane, in whatever placement opened it.
 *
 * Thin on purpose. `ControlPane` is the ported chrome and this is the only
 * thing between it and the router, which is where a second surface would be
 * added if one were ever declared. The compiled pane took nine props from
 * whichever chat or rail mounted it; this one takes the host's context and
 * nothing else, because a page has no parent to hand it anything.
 */

import React from "react";

import type { PluginWebviewContext } from "../bridge";
import { ControlPane } from "../components/ControlPane";

export function ControlEntry({ context }: { context: PluginWebviewContext }): React.ReactElement {
  return <ControlPane context={context} />;
}
