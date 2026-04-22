import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const workHighlightsTour: Tour = {
  id: "work",
  title: "Work · essentials",
  variant: "highlights",
  route: "/work",
  steps: [
    {
      id: "h.work.what",
      target: "",
      title: "Work",
      body: "Every chat, CLI tool, and shell across every lane, in one list. Unlike a lane's embedded Work view, this one isn't scoped to one lane.",
      docUrl: docs.chatOverview,
    },
    {
      id: "h.work.sessions",
      target: '[data-tour="work.sessionsPane"]',
      title: "Session list",
      body: "Click any session to open it. Filter by lane to narrow the list.",
      docUrl: docs.terminals,
      placement: "right",
    },
    {
      id: "h.work.next",
      target: "",
      title: "Want the whole thing?",
      body: "The full walkthrough covers new sessions, the view area, and cross-lane switching. Replay from the ? menu.",
    },
  ],
};

registerTour(workHighlightsTour);
export default workHighlightsTour;
