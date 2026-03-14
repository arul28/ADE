import React, { useCallback } from "react";
import { ComputerUseSection } from "./ComputerUseSection";
import { ExternalMcpSection } from "./ExternalMcpSection";
import { GitHubSection } from "./GitHubSection";
import { LinearSection } from "./LinearSection";

export function IntegrationsSettingsSection() {
  const scrollToExternalMcp = useCallback(() => {
    document.getElementById("settings-external-mcp")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <GitHubSection />
      <LinearSection />
      <div id="settings-computer-use">
        <ComputerUseSection onOpenExternalMcp={scrollToExternalMcp} />
      </div>
      <div id="settings-external-mcp">
        <ExternalMcpSection />
      </div>
    </div>
  );
}
