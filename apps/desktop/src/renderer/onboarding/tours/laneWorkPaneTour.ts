import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const laneWorkPaneTour: Tour = {
  id: "lane-work-pane",
  title: "Lane work pane walkthrough",
  route: "/lanes",
  steps: [
    {
      target: '[data-tour="work.toolbar"]',
      title: "Lane Work Pane",
      body: "This pane is the command center for the selected lane. Anything you start here uses this lane's branch and folder, so experiments stay separate from primary.",
      docUrl: docs.chatOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="work.entryOptions"]',
      title: "Start a new session",
      body: "Pick the kind of help you need: New Chat for an agent conversation, CLI Tool for command-oriented agent work, or New Shell when you want a normal terminal in the lane folder.",
      docUrl: docs.chatOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.workNewChat"]',
      title: "AI chat",
      body: "Use New Chat when the task is conversational. Example: \"Find why the login form flashes, fix it in this lane, and show me the changed files.\"",
      docUrl: docs.chatOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.workCliTool"]',
      title: "CLI tool",
      body: "Use CLI Tool when the task is command-shaped. Example: \"Run the focused tests for the files changed in this lane and summarize failures.\"",
      docUrl: docs.terminals,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.workNewShell"]',
      title: "Shell terminal",
      body: "Use New Shell when you want direct control. It opens a terminal already pointed at this lane's worktree, so commands affect the lane you are viewing.",
      docUrl: docs.terminals,
      placement: "bottom",
    },
    {
      target: '[data-tour="work.laneName"]',
      title: "Lane context",
      body: "This label is the safety check. If it says `checkout-page`, the chats and shells here see the checkout-page branch and files. Switch lanes before starting work for another task.",
      docUrl: docs.lanesOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="work.sessionCount"]',
      title: "Open sessions",
      body: "This count tells you how many chats or terminals are open for this lane. It is normal to have zero before you ask an agent or open a shell.",
      docUrl: docs.chatOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="work.viewArea"]',
      title: "Session view area",
      body: "Open chats and terminals appear here. If it is empty, nothing is broken; it simply means this lane has no active work session yet.",
      docUrl: docs.chatOverview,
      placement: "top",
    },
  ],
};

registerTour(laneWorkPaneTour);

export default laneWorkPaneTour;
