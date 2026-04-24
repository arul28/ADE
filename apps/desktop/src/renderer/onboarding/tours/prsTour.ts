import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const prsTour: Tour = {
  id: "prs",
  title: "PRs walkthrough",
  route: "/prs",
  steps: [
    {
      target: '[data-tour="prs.list"]',
      title: "PR list",
      body: "The list shows GitHub PRs and ADE-linked lanes. Select a row before inspecting checks, convergence, or close actions.",
      docUrl: docs.prsOverview,
      placement: "right",
    },
    {
      target: '[data-tour="prs.detailDrawer"], [data-tour="prs.list"]',
      title: "Checks",
      body: "Checks appear inside a selected PR. They show CI state and where to look when a review is blocked.",
      docUrl: docs.prsOverview,
      placement: "left",
    },
    {
      target: '[data-tour="prs.detailDrawer"], [data-tour="prs.list"]',
      title: "Path to merge",
      body: "The convergence tab tracks checks, review comments, conflicts, and resolver runs for the selected PR.",
      docUrl: docs.prsOverview,
      placement: "left",
    },
    {
      target: '[data-tour="prs.detailDrawer"], [data-tour="prs.list"]',
      title: "Queue context",
      body: "When a PR belongs to a queue, this control links back to that queue.",
      docUrl: docs.lanesStacks,
      placement: "left",
    },
  ],
};

registerTour(prsTour);

export default prsTour;
