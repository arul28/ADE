import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const workTour: Tour = {
  id: "work",
  title: "Work tab walkthrough",
  route: "/work",
  steps: [
    {
      target: '[data-tour="work.sessionsPane"]',
      title: "All sessions, one place",
      body: "Every session across every lane lives here. Unlike the Lane Work Pane, this view isn't scoped to one lane.",
      docUrl: docs.chatOverview,
      placement: "right",
    },
    {
      target: '[data-tour="work.laneFilter"]',
      title: "Filter by lane",
      body: "Filter sessions by lane or show them all. Handy when you have workers running across several worktrees.",
      docUrl: docs.lanesOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="work.newSession"]',
      title: "Start a new session",
      body: "Start a new chat, CLI tool, or shell from here. The session attaches to whichever lane you pick.",
      docUrl: docs.chatOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="work.sessionItem"]',
      title: "Open a session",
      body: "Click a session to open its view. Right-click for rename, resume, delete, and other actions.",
      docUrl: docs.chatOverview,
      placement: "right",
    },
    {
      target: '[data-tour="work.viewArea"]',
      title: "Session view area",
      body: "Open chats and terminals live here. Drag tabs to rearrange, close a tab to reclaim space.",
      docUrl: docs.terminals,
      placement: "left",
    },
    {
      target: '[data-tour="work.crossLaneSwitch"]',
      title: "Cross-lane viewing",
      body: "Switching sessions here doesn't change your active lane — just what you're looking at. Jump to the lane via right-click → Go to lane.",
      docUrl: docs.lanesOverview,
      placement: "right",
    },
  ],
};

registerTour(workTour);

export default workTour;
