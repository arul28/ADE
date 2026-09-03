/**
 * The surface router.
 *
 * `surfaceId` is the host's word for which manifest surface this guest draws.
 * There is exactly ONE — `control` — and the default arm is not dead code: a
 * host that grew a placement this build does not know should still show the
 * reader the pane rather than an error page, and a bare handshake that answered
 * no surface id at all lands here too.
 *
 * There is no phone surface, by declaration: every `webview` sets
 * `"mobile": false`, and the phone draws the `main` panel's status row instead.
 * Driving an Electron app over CDP needs the computer the app is running on.
 */

import React from "react";

import type { PluginWebviewContext } from "./bridge";
import { ControlEntry } from "./entries/ControlEntry";

export const PAGE_SURFACE_IDS = ["control"] as const;

export type PageSurfaceId = (typeof PAGE_SURFACE_IDS)[number];

export function PageRouter({ context }: { context: PluginWebviewContext }): React.ReactElement {
  switch (context.surfaceId) {
    case "control":
    default:
      return <ControlEntry context={context} />;
  }
}
