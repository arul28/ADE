import React from "react";
import { LinearSection } from "./LinearSection";
import { LinearMark } from "../lanes/linearBrand";
import { SettingsSectionShell } from "./settingsSectionUi";

const LINEAR_BRAND = "#5E6AD2";

export function LinearIntegrationSection() {
  return (
    <SettingsSectionShell
      title="Linear integration"
      description="Issues in lanes and chats, PR links, and the ADE agent."
      brandColor={LINEAR_BRAND}
      iconNode={<LinearMark size={22} />}
    >
      <LinearSection embedded />
    </SettingsSectionShell>
  );
}
