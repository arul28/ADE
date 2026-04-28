import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const ctoHighlightsTour: Tour = {
  id: "cto",
  title: "CTO · essentials",
  variant: "highlights",
  route: "/cto",
  steps: [
    {
      id: "h.cto.what",
      target: "",
      title: "Your CTO",
      body: "A persistent AI agent that leads an org chart of workers, syncs with Linear, and remembers across sessions.",
      docUrl: docs.ctoOverview,
    },
    {
      id: "h.cto.sidebar",
      target: '[data-tour="cto.sidebar"]',
      title: "The org chart",
      body: "The left sidebar lists every agent and their role. Click one to chat or reassign tasks.",
      docUrl: docs.ctoOverview,
      placement: "right",
    },
    {
      id: "h.cto.next",
      target: "",
      title: "Want the whole thing?",
      body: "The full walkthrough covers personality setup, team management, and Linear sync. Replay from the ? menu.",
    },
  ],
};

registerTour(ctoHighlightsTour);
export default ctoHighlightsTour;
