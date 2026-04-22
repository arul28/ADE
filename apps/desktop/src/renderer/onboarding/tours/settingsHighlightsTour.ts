import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const settingsHighlightsTour: Tour = {
  id: "settings",
  title: "Settings · essentials",
  variant: "highlights",
  route: "/settings",
  steps: [
    {
      id: "h.settings.what",
      target: "",
      title: "Settings",
      body: "App-wide configuration: theme, AI providers, sync, memory, lane templates, integrations.",
      docUrl: docs.settingsGeneral,
    },
    {
      id: "h.settings.ai",
      target: '[data-tour="settings.ai"]',
      title: "AI providers",
      body: "Auth each provider you want workers to use. Claude and Codex are the main two; Cursor is optional.",
      docUrl: docs.settingsGeneral,
      placement: "right",
    },
    {
      id: "h.settings.next",
      target: "",
      title: "Want the whole thing?",
      body: "Use Walkthrough in the ? menu for the detailed pass across this page.",
    },
  ],
};

registerTour(settingsHighlightsTour);
export default settingsHighlightsTour;
