import React from "react";
import { LinearSection } from "./LinearSection";

/**
 * Settings › Integrations › Linear. The tab's block already names the group,
 * so the section's own headings (Connection, ADE agent, …) carry the page.
 */
export function LinearIntegrationSection() {
  return <LinearSection embedded />;
}
