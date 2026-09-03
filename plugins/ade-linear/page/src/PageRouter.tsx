/**
 * The surface router.
 *
 * `surfaceId` is the host's word for which manifest surface this guest draws.
 * Unknown ids fall through to the browser rather than to an error page: a host
 * that grew a placement this build does not know should still show the reader
 * their issues.
 */

import React from "react";

import type { PluginWebviewContext } from "./bridge";
import { BadgeCardEntry } from "./entries/BadgeCardEntry";
import { BrowserEntry } from "./entries/BrowserEntry";
import { IssueContextEntry } from "./entries/IssueContextEntry";
import { PickerEntry } from "./entries/PickerEntry";
import { QuickViewEntry } from "./entries/QuickViewEntry";
import { SettingsEntry } from "./entries/SettingsEntry";

export const PAGE_SURFACE_IDS = [
  "issues",
  "quickview",
  "settings",
  "picker",
  "badge-card",
  "issue-context",
] as const;

export type PageSurfaceId = (typeof PAGE_SURFACE_IDS)[number];

export function PageRouter({ context }: { context: PluginWebviewContext }): React.ReactElement {
  switch (context.surfaceId) {
    case "quickview":
      return <QuickViewEntry context={context} />;
    case "settings":
      return <SettingsEntry context={context} />;
    case "picker":
      return <PickerEntry context={context} />;
    case "badge-card":
      return <BadgeCardEntry context={context} />;
    case "issue-context":
      return <IssueContextEntry context={context} />;
    // `issues` is the rail tab, and it keeps that id from before the page tier:
    // a tab badge is addressed by `"<pluginId>/<surfaceId>"`, so renaming it
    // would silently orphan every badge and deeplink pointing at the old one.
    case "issues":
    default:
      return <BrowserEntry context={context} />;
  }
}
