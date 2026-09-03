/**
 * The surface router.
 *
 * One surface today — `sim` — and the switch exists anyway, for the same reason
 * Linear's does: `surfaceId` is the host's own word for which manifest surface
 * this guest draws, and an unknown id must fall through to the pane rather than
 * to an error page. A host that grew a placement this build does not know
 * should still show the reader their simulator.
 */

import React from "react";

import type { PluginWebviewContext } from "./bridge";
import { SimEntry } from "./entries/SimEntry";

export const PAGE_SURFACE_IDS = ["sim"] as const;

export type PageSurfaceId = (typeof PAGE_SURFACE_IDS)[number];

export function PageRouter({ context }: { context: PluginWebviewContext }): React.ReactElement {
  switch (context.surfaceId) {
    case "sim":
    default:
      return <SimEntry context={context} />;
  }
}
