import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const lanesHighlightsTour: Tour = {
  id: "lanes",
  title: "Lanes · essentials",
  variant: "highlights",
  route: "/lanes",
  steps: [
    {
      id: "h.lanes.what",
      target: "",
      title: "Lanes",
      body: "Every lane is its own worktree, branch, and chat. You run many of them in parallel.",
      docUrl: docs.lanesOverview,
    },
    {
      id: "h.lanes.new",
      target: '[data-tour="lanes.newLane"]',
      title: "Make a new one",
      body: "New Lane spawns a fresh worktree off the branch selected in the top-left.",
      docUrl: docs.lanesCreating,
      placement: "bottom",
    },
    {
      id: "h.lanes.next",
      target: "",
      title: "Want the whole thing?",
      body: "The full walkthrough covers the stack, git actions, worktrees, and Manage Lane. Replay it from the ? menu.",
    },
  ],
};

registerTour(lanesHighlightsTour);
export default lanesHighlightsTour;
