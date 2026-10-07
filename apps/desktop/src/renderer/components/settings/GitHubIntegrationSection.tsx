import React from "react";
import { GitHubSection } from "./GitHubSection";
import { useSettingsMachineScope } from "./SettingsMachineScope";

/**
 * Settings › Integrations › GitHub. The tab's block already names the group,
 * so the section's own headings (Connection, Access order, …) carry the page.
 *
 * Keyed on the machine's pin: a new pin starts a fresh section, so nothing
 * the last machine was doing (a device code, a pending save) lands here.
 */
export function GitHubIntegrationSection() {
  const { pin } = useSettingsMachineScope();
  return <GitHubSection key={pin?.key ?? "unpinned"} embedded />;
}
