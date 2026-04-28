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
      id: "h.run.stacks",
      target: '[data-tour="run.stackTabs"]',
      title: "Stacks",
      body: "Group commands into stacks that boot together. The process monitor on the right tracks their state.",
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
