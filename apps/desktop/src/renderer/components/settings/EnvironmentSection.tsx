import React from "react";
import { GearSix } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, cardStyle } from "../lanes/laneDesignTokens";
import { AboutSection } from "./AboutSection";
import { AdeCliSection } from "./AdeCliSection";
import { SettingsSectionShell } from "./settingsSectionUi";

const dividerStyle: React.CSSProperties = {
  borderTop: `1px solid ${COLORS.border}`,
  margin: "18px 0",
};

export function EnvironmentSection() {
  return (
    <SettingsSectionShell
      title="Environment"
      description={
        <>
          App version, background runtime, and the <span style={{ fontFamily: MONO_FONT, fontSize: 11 }}>ade</span> command for your Terminal.
        </>
      }
      icon={GearSix}
      brandColor="#38BDF8"
      iconWeight="fill"
    >
      <div style={cardStyle({ padding: 16 })}>
        <AboutSection embedded />
        <div style={dividerStyle} />
        <AdeCliSection compact embedded />
      </div>
    </SettingsSectionShell>
  );
}
