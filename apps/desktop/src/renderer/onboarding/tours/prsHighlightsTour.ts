import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const prsHighlightsTour: Tour = {
  id: "prs",
  title: "PRs · essentials",
  variant: "highlights",
  route: "/prs",
  steps: [
    {
      id: "h.prs.what",
      target: "",
      title: "Pull requests",
      body: "Every lane with an open PR lives here — checks, stack position, conflict predictions, and the merge button.",
      docUrl: docs.prsOverview,
    },
    {
      id: "h.prs.list",
      target: '[data-tour="prs.list"]',
      title: "The list",
      body: "Click any row to drill into its checks, files, and conversation.",
      docUrl: docs.prsOverview,
      placement: "right",
    },
    {
      id: "h.prs.next",
      target: "",
      title: "Want the whole thing?",
      body: "The full walkthrough covers creating, stacking, conflict simulation, and close-from-here. Replay from the ? menu.",
    },
  ],
};

registerTour(prsHighlightsTour);
export default prsHighlightsTour;
