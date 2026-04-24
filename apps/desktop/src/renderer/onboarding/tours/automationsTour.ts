import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const automationsTour: Tour = {
  id: "automations",
  title: "Automations walkthrough",
  route: "/automations",
  steps: [
    {
      target: '[data-tour="automations.createTrigger"]',
      title: "Triggers",
      body: "Triggers decide what starts an automation: schedule, webhook, git event, or file watch.",
      docUrl: docs.automationsOverview,
      placement: "right",
    },
    {
      target: '[data-tour="automations.createTrigger"]',
      title: "Actions",
      body: "Actions run after a trigger fires: launch a command, dispatch a mission, or notify a worker.",
      docUrl: docs.automationsOverview,
      placement: "right",
    },
    {
      target: '[data-tour="automations.createTrigger"]',
      title: "Guardrails",
      body: "Guardrails cover rate limits, concurrency caps, quiet hours, and approval boundaries.",
      docUrl: docs.automationsOverview,
      placement: "right",
    },
  ],
};

registerTour(automationsTour);

export default automationsTour;
