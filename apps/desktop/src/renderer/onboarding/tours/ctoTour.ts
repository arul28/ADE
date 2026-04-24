import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const ctoTour: Tour = {
  id: "cto",
  title: "CTO walkthrough",
  route: "/cto",
  steps: [
    {
      target: '[data-tour="cto.sidebar"]',
      title: "Agents",
      body: "The sidebar lists the agents the CTO manages. Identities persist between sessions.",
      docUrl: docs.ctoOverview,
      placement: "right",
    },
    {
      target: '[data-tour="cto.teamPanel"]',
      title: "Team panel",
      body: "Inspect, edit, or archive agents. Budget caps and heartbeat intervals live here too.",
      docUrl: docs.ctoOverview,
      placement: "left",
    },
    {
      target: '[data-tour="cto.linearPanel"]',
      title: "Linear sync",
      body: "Connect Linear to let the CTO dispatch missions from tickets and report results back.",
      docUrl: docs.ctoOverview,
      placement: "left",
    },
  ],
};

registerTour(ctoTour);

export default ctoTour;
