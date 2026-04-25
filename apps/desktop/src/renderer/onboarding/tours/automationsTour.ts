import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const automationsTour: Tour = {
  id: "automations",
  title: "Automations walkthrough",
  route: "/automations",
  steps: [
    {
      target: '[data-tour="automations.createTrigger"]',
      title: "If this happens, do that",
      body: "An automation is a little \"if/then\" rule that runs in the background. Three parts: a **trigger** (what kicks it off — a schedule, a button push, a Git event, a file change), an **action** (what it does — run a command, ask AI to do something, send a ping), and **guardrails** (limits to keep it safe — like \"don't run more than 3 of these at once\"). Click here to set one up.",
      docUrl: docs.automationsOverview,
      placement: "right",
    },
  ],
};

registerTour(automationsTour);

export default automationsTour;
