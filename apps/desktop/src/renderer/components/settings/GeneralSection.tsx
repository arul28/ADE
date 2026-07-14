import React from "react";
import { AgentCompletionSoundSection } from "./AgentCompletionSoundSection";
import { DictationSection } from "./DictationSection";
import { EnvironmentSection } from "./EnvironmentSection";
import { GitHubIntegrationSection } from "./GitHubIntegrationSection";
import { LaunchPromptSection } from "./LaunchPromptSection";
import { LinearIntegrationSection } from "./LinearIntegrationSection";
import { PrChatTranscriptsSection } from "./PrChatTranscriptsSection";
import { ProductAnalyticsSection } from "./ProductAnalyticsSection";
import { ProjectSection } from "./ProjectSection";

export function GeneralSection() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 40 }}>
      <GitHubIntegrationSection />

      <LinearIntegrationSection />

      <DictationSection />

      <LaunchPromptSection />

      <AgentCompletionSoundSection />

      <PrChatTranscriptsSection />

      <ProductAnalyticsSection />

      <ProjectSection />

      <EnvironmentSection />
    </div>
  );
}
