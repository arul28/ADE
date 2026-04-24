import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const historyTour: Tour = {
  id: "history",
  title: "History walkthrough",
  route: "/history",
  steps: [
    {
      target: '[data-tour="history.entries"]',
      title: "Timeline",
      body: "Recent events sit at the top. Lane creation, commits, pushes, PR activity, and missions all land here.",
      docUrl: docs.historyOverview,
      placement: "right",
    },
    {
      target: '[data-tour="history.filter"]',
      title: "Filters",
      body: "Filter by importance or kind when the project gets noisy.",
      docUrl: docs.historyOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="history.export"]',
      title: "Column settings",
      body: "Tune which timeline details matter for review, handoff, or debugging.",
      docUrl: docs.historyOverview,
      placement: "bottom",
    },
  ],
};

registerTour(historyTour);

export default historyTour;
