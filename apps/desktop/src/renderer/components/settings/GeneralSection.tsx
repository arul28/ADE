import React from "react";
import { AgentCompletionSoundSection } from "./AgentCompletionSoundSection";
import { AutoUpdatesSection } from "./AutoUpdatesSection";
import { DictationSection } from "./DictationSection";
import { EnvironmentSection } from "./EnvironmentSection";
import { GitHubIntegrationSection } from "./GitHubIntegrationSection";
import { LaunchPromptSection } from "./LaunchPromptSection";
import { LinearIntegrationSection } from "./LinearIntegrationSection";
import { PrChatTranscriptsSection } from "./PrChatTranscriptsSection";
import { ProductAnalyticsSection } from "./ProductAnalyticsSection";
import { ProjectSection } from "./ProjectSection";
import { SessionLifecycleSection } from "./SessionLifecycleSection";

export function GeneralSection() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 40 }}>
      <GitHubIntegrationSection />

      <LinearIntegrationSection />

      <DictationSection />

      <LaunchPromptSection />

      <AgentCompletionSoundSection />

      <PrChatTranscriptsSection />

      <SessionLifecycleSection />

      <AutoUpdatesSection />

      <ProductAnalyticsSection />

      <ProjectSection />

      <EnvironmentSection />
    </div>
  );
}
