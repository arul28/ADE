import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const laneWorkPaneHighlightsTour: Tour = {
  id: "lane-work-pane",
  title: "Lane work pane · essentials",
  variant: "highlights",
  route: "/lanes",
  steps: [
    {
      id: "h.lwp.what",
      target: '[data-tour="work.viewArea"]',
      title: "Lane work pane",
      body: "Work inside a lane — chats, CLI tools, and shells all run in that lane's worktree, nothing else.",
      docUrl: docs.chatOverview,
      placement: "top",
    },
    {
      id: "h.lwp.next",
      target: "",
      title: "Want the whole thing?",
      body: "The full walkthrough covers every control. Replay from the ? menu.",
    },
  ],
};

registerTour(laneWorkPaneHighlightsTour);
export default laneWorkPaneHighlightsTour;
