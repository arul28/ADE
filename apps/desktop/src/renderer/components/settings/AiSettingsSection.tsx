import React from "react";
import { AiFeaturesSection } from "./AiFeaturesSection";
import { ProvidersSection } from "./ProvidersSection";

export function AiSettingsSection() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <ProvidersSection />
      <AiFeaturesSection />
    </div>
  );
}
