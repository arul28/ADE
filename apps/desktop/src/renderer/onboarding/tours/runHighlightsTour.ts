import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const runHighlightsTour: Tour = {
  id: "run",
  title: "Run · essentials",
  variant: "highlights",
  route: "/project",
  steps: [
    {
      id: "h.run.what",
      target: "",
      title: "Run",
      body: "Dev servers, tests, long-running scripts — every process ADE knows how to start lives here.",
      docUrl: docs.lanesStacks,
    },
    {
      id: "h.run.groups",
      target: '[data-tour="run.groupFilter"]',
      title: "Groups",
      body: "Assign commands to groups, filter by group here, and bulk run or stop from the header when a group is selected. Each command card shows live status, lane, uptime, and ended time at the bottom.",
      docUrl: docs.lanesStacks,
      placement: "bottom",
    },
    {
      id: "h.run.next",
      target: "",
      title: "Want the whole thing?",
      body: "The full walkthrough covers the command editor and runtime bar. Replay from the ? menu.",
    },
  ],
};

registerTour(runHighlightsTour);
export default runHighlightsTour;
