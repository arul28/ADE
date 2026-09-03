/**
 * The quick-view surface.
 *
 * The manifest's `toolbar-action` answers
 * `{openWebview:{surfaceId:"quickview",placement:"popover"}}`, so this entry is
 * the popover's whole body: the compiled quick view's header, search, nav verbs
 * and list, sized to the popover rather than to a floating window.
 *
 * It is deliberately thin. The panel owns the batch-launch modal, the status
 * toast, the launched-lane state and the deeplink-driven issue focus, exactly
 * as `LinearQuickViewButton` owned them in the compiled app; the entry's only
 * job is to hand it the host's context.
 *
 * `context.pointer` is where an `{issueIdentifier}` from the toolbar action
 * arrives — the page's replacement for `linearIssueQuickViewNavigation`'s
 * module-level request bus, which a guest cannot share with the app.
 */

import React from "react";

import type { PluginWebviewContext } from "../bridge";
import { LinearQuickViewPanel } from "../components/LinearQuickViewPanel";

export function QuickViewEntry({ context }: { context: PluginWebviewContext }): React.ReactElement {
  return <LinearQuickViewPanel context={context} />;
}
