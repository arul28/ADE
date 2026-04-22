import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const lanesTour: Tour = {
  id: "lanes",
  title: "Lanes tour",
  route: "/lanes",
  steps: [
    {
      target: '[data-tour="lanes.branchSelector"]',
      title: "Your main branch",
      body: "Every Lane is compared to this branch. Click to switch — new Lanes will start from whatever you pick.",
      docUrl: docs.lanesOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.statusChips"]',
      title: "Filter by status",
      body: "Narrow the view to Lanes that are Running, waiting on you, or Ended. Click a chip again to clear.",
      docUrl: docs.lanesOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.newLane"]',
      title: "Make a new Lane",
      body: "A Lane is just a Git worktree — its own folder with its own branch. Click here to spin one up.",
      docUrl: docs.lanesCreating,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.laneTab"]',
      title: "Lane tabs",
      body: "Each tab is one Lane. Badges tell you at a glance if it's Pinned, Dirty, or Behind its base branch.",
      docUrl: docs.lanesOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.addWorktrees"]',
      title: "Already have worktrees?",
      body: "Point ADE at existing Git worktrees and they become Lanes instantly — no copying, no moving.",
      docUrl: docs.lanesCreating,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.stackPane"]',
      title: "Stack pane",
      body: "Start, stop, and watch the apps this Lane runs — dev server, tests, anything scripted.",
      docUrl: docs.lanesStacks,
      placement: "right",
    },
    {
      target: '[data-tour="lanes.gitActionsPane"]',
      title: "Git, in plain words",
      body: "Commit, push, rebase — all explained. No command line required.",
      docUrl: docs.lanesOverview,
      placement: "right",
    },
    {
      target: '[data-tour="lanes.diffPane"]',
      title: "See what changed",
      body: "The Diff pane walks every change in this Lane, file by file. Red removed, green added.",
      docUrl: docs.lanesOverview,
      placement: "left",
    },
    {
      target: '[data-tour="lanes.workPane"]',
      title: "The Work pane",
      body: "Chat with a Worker, run a one-off command, or open a shell — all scoped to this Lane's worktree.",
      docUrl: docs.chatOverview,
      placement: "left",
    },
    {
      target: '[data-tour="app.helpMenu"]',
      title: "Help lives here",
      body: "The ? button holds every tour, the Glossary, and a link to the docs. Revisit it whenever you need a refresher.",
      docUrl: docs.welcome,
      placement: "bottom",
    },
  ],
};

registerTour(lanesTour);

export default lanesTour;
