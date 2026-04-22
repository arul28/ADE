import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const historyHighlightsTour: Tour = {
  id: "history",
  title: "History · essentials",
  variant: "highlights",
  route: "/history",
  steps: [
    {
      id: "h.history.what",
      target: "",
      title: "History",
      body: "A timeline of everything that happened: lane created, commit, push, PR opened, mission step — every event, forever.",
      docUrl: docs.home,
    },
    {
      id: "h.history.entries",
      target: '[data-tour="history.entries"]',
      title: "The timeline",
      body: "Filter by importance or kind. Click an entry to drill in or jump to the thing it's about.",
      docUrl: docs.home,
      placement: "right",
    },
    {
      id: "h.history.next",
      target: "",
      title: "Want the whole thing?",
      body: "The full walkthrough covers export and advanced filters. Replay from the ? menu.",
    },
  ],
};

registerTour(historyHighlightsTour);
export default historyHighlightsTour;
