import React from "react";
import { AiFeaturesSection } from "./AiFeaturesSection";
import { ProvidersSection } from "./ProvidersSection";

export function AiSettingsSection({ forceProviderRefreshOnMount = false }: { forceProviderRefreshOnMount?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <ProvidersSection forceRefreshOnMount={forceProviderRefreshOnMount} />
      <AiFeaturesSection />
    </div>
  );
}
