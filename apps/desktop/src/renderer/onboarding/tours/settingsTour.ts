import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const settingsTour: Tour = {
  id: "settings",
  title: "Settings walkthrough",
  route: "/settings",
  steps: [
    {
      target: '[data-tour="settings.appearance"]',
      title: "Appearance",
      body: "Theme, density, accent color, and contrast settings live here.",
      docUrl: docs.settingsGeneral,
      placement: "right",
    },
    {
      target: '[data-tour="settings.ai"]',
      title: "AI providers",
      body: "Connect Claude, OpenAI, local models, or custom endpoints. Workers use these providers per session.",
      docUrl: docs.settingsGeneral,
      placement: "right",
    },
    {
      target: '[data-tour="settings.memory"]',
      title: "Memory",
      body: "Inspect and prune what ADE agents remember. Pin facts, consolidate episodes, and set retention caps.",
      docUrl: docs.settingsGeneral,
      placement: "right",
    },
    {
      target: '[data-tour="settings.laneTemplates"]',
      title: "Lane templates",
      body: "Save reusable lane recipes with commands, runtimes, and setup defaults.",
      docUrl: docs.settingsGeneral,
      placement: "right",
    },
  ],
};

registerTour(settingsTour);

export default settingsTour;
