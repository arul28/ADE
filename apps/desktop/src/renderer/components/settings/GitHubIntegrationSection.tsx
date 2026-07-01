import React from "react";
import { GithubLogo } from "@phosphor-icons/react";
import { GitHubSection } from "./GitHubSection";
import { SettingsSectionShell } from "./settingsSectionUi";

export function GitHubIntegrationSection() {
  return (
    <SettingsSectionShell
      id="github-connection"
      title="GitHub integration"
      description="Authenticate with GitHub CLI or a personal access token, and install ADE for GitHub for webhook-backed PR updates."
      icon={GithubLogo}
      brandColor="#3FB950"
      iconWeight="fill"
    >
      <GitHubSection embedded />
    </SettingsSectionShell>
  );
}
