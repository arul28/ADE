import React from "react";
import { ContextSection } from "./ContextSection";
import { ExecutionTargetsSection } from "./ExecutionTargetsSection";
import { ProjectSection } from "./ProjectSection";

export function WorkspaceSettingsSection() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <ProjectSection />
      <ExecutionTargetsSection />
      <ContextSection />
    </div>
  );
}
