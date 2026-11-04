import React from "react";
import { GitHubSection } from "./GitHubSection";
import { useSettingsMachineScope } from "./SettingsMachineScope";

/**
 * Settings › Integrations › GitHub: the GitHub page, banner and cards.
 *
 * Keyed on the machine's pin: a new pin starts a fresh section, so nothing
 * the last machine was doing (a device code, a pending save) lands here.
 */
export function GitHubIntegrationSection() {
  const { pin } = useSettingsMachineScope();
  return <GitHubSection key={pin?.key ?? "unpinned"} />;
}
