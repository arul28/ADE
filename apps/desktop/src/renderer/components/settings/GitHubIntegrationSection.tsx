import React from "react";
import { GitHubSection } from "./GitHubSection";

/**
 * Settings › Integrations › GitHub. The tab's block already names the group,
 * so the section's own headings (Connection, Access order, …) carry the page.
 */
export function GitHubIntegrationSection() {
  return <GitHubSection embedded />;
}
