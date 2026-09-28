import React from "react";
import { GithubLogo } from "@phosphor-icons/react";
import { GitHubSection } from "./GitHubSection";
import { SettingsSectionShell } from "./settingsSectionUi";

export function GitHubIntegrationSection() {
  return (
    <SettingsSectionShell
      title="GitHub integration"
      description="Sign in with the GitHub CLI or a token, and add ADE for GitHub for live PR updates."
      icon={GithubLogo}
      brandColor="#3FB950"
      iconWeight="fill"
    >
      <GitHubSection embedded />
    </SettingsSectionShell>
  );
}
