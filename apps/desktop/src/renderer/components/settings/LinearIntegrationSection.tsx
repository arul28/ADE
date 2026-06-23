import React from "react";
import { LinearSection } from "./LinearSection";
import { LinearMark } from "../lanes/linearBrand";
import { SettingsSectionShell } from "./settingsSectionUi";

const LINEAR_BRAND = "#5E6AD2";

export function LinearIntegrationSection() {
  return (
    <SettingsSectionShell
      id="linear-connection"
      title="Linear integration"
      description="Connect Linear for issue routing, lane context, PR linkage, and CTO workflows."
      brandColor={LINEAR_BRAND}
      iconNode={<LinearMark size={22} />}
    >
      <LinearSection embedded />
    </SettingsSectionShell>
  );
}
