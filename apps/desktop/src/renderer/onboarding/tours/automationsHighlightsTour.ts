import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const automationsHighlightsTour: Tour = {
  id: "automations",
  title: "Automations · essentials",
  variant: "highlights",
  route: "/automations",
  steps: [
    {
      id: "h.auto.what",
      target: "",
      title: "Automations",
      body: "Rules that fire when something happens — commit, session end, PR opened — and run actions you've approved.",
      docUrl: docs.automationsOverview,
    },
    {
      id: "h.auto.rules",
      target: '[data-tour="automations.triggersList"]',
      title: "Rules, triggers, actions",
      body: "Each rule is a trigger plus one or more actions. Guardrails keep anything risky behind an approval.",
      docUrl: docs.automationsOverview,
      placement: "right",
    },
    {
      id: "h.auto.next",
      target: "",
      title: "Want the whole thing?",
      body: "The full walkthrough covers trigger kinds and action types. Replay from the ? menu.",
    },
  ],
};

registerTour(automationsHighlightsTour);
export default automationsHighlightsTour;
