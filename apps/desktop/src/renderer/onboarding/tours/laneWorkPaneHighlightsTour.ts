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
      target: "",
      title: "Lane work pane",
      body: "Work inside a lane — chats, CLI tools, and shells all run in that lane's worktree, nothing else.",
      docUrl: docs.chatOverview,
    },
    {
      id: "h.lwp.entry",
      target: '[data-tour="work.entryOptions"]',
      title: "Three ways in",
      body: "New Chat talks to a worker. CLI Tool wraps commands in AI. New Shell drops you into a terminal.",
      docUrl: docs.terminals,
      placement: "bottom",
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
