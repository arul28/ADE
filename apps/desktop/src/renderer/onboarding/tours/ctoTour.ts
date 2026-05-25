import { registerTour, type StepAction, type Tour } from "../registry";
import { docs } from "../docsLinks";

function switchCtoTab(tab: "team" | "workflows" | "settings"): StepAction[] {
  return [{
    type: "ipc",
    call: async () => {
      window.dispatchEvent(new CustomEvent("ade:tour-cto-tab", { detail: tab }));
    },
  }];
}

export const ctoTour: Tour = {
  id: "cto",
  title: "CTO walkthrough",
  route: "/cto",
  steps: [
    {
      target: '[data-tour="cto.sidebar"]',
      title: "Your AI team",
      body: "Everyone on this list is an AI helper the CTO manages — like team members. Each one has a name, a role, and remembers things between sessions, so you don't have to re-explain context every time.",
      docUrl: docs.ctoOverview,
      placement: "right",
    },
    {
      target: '[data-tour="cto.teamPanel"]',
      title: "Manage them like a real team",
      body: "Look at what each AI helper is doing, change their role, or set them aside. You can also cap how much they're allowed to spend per month here — useful while you're learning what they're good for.",
      docUrl: docs.ctoOverview,
      placement: "left",
      beforeEnter: () => switchCtoTab("team"),
    },
    {
      target: '[data-tour="cto.linearPanel"]',
      title: "Hook up your task list",
      body: "Use Linear (a popular project management tool) to track work? Connect it here and the CTO will turn tickets into AI tasks automatically, then post results back to the ticket. Skip if you don't use Linear.",
      docUrl: docs.ctoOverview,
      placement: "left",
      beforeEnter: () => switchCtoTab("workflows"),
    },
  ],
};

registerTour(ctoTour);

export default ctoTour;
