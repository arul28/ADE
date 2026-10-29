import React from "react";
import { LinearSection } from "./LinearSection";
import { useSettingsMachineScope } from "./SettingsMachineScope";

/**
 * Settings › Integrations › Linear: the Linear page, banner and cards.
 *
 * Keyed on the machine's pin: a new pin starts a fresh section, so nothing
 * the last machine was doing (an OAuth sign-in, an agent install) lands here.
 */
export function LinearIntegrationSection() {
  const { pin } = useSettingsMachineScope();
  return <LinearSection key={pin?.key ?? "unpinned"} />;
}
