import React from "react";
import { LinearSection } from "./LinearSection";
import { LinearMark } from "../lanes/linearBrand";
import { useBuiltinSurfaceVisible } from "../plugins/useBuiltinTabs";
import { SettingsSectionShell } from "./settingsSectionUi";

const LINEAR_BRAND = "#5E6AD2";

export function LinearIntegrationSection() {
  // Gated inside the section rather than at the Settings render site: this
  // wrapper exists only to head `LinearSection` on the Integrations tab, so it
  // has exactly one owner and returning null here takes the heading with it.
  // Hidden is the default — the gate stays false until the registry resolves.
  // Integrations still shows GitHub, so the tab never renders empty.
  const linearSurfaceVisible = useBuiltinSurfaceVisible("linear");
  if (!linearSurfaceVisible) return null;
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
