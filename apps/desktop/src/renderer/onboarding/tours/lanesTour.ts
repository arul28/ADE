import { registerTour, type Tour } from "../registry";

const DOCS = "https://www.ade-app.dev/docs";

export const lanesTour: Tour = {
  id: "lanes",
  title: "Lanes tour",
  route: "/lanes",
  steps: [
    {
      target: '[data-tour="lanes.branchSelector"]',
      title: "Your main branch",
      body: "Every Lane is compared to this branch. Click to switch — new Lanes will start from whatever you pick.",
      docUrl: `${DOCS}/lanes/overview`,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.statusChips"]',
      title: "Filter by status",
      body: "Narrow the view to Lanes that are Running, waiting on you, or Ended. Click a chip again to clear.",
      docUrl: `${DOCS}/lanes/overview`,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.newLane"]',
      title: "Make a new Lane",
      body: "A Lane is just a Git worktree — its own folder with its own branch. Click here to spin one up.",
      docUrl: `${DOCS}/lanes/creating`,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.laneTab"]',
      title: "Lane tabs",
      body: "Each tab is one Lane. Badges tell you at a glance if it's Pinned, Dirty, or Behind its base branch.",
      docUrl: `${DOCS}/lanes/overview`,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.addWorktrees"]',
      title: "Already have worktrees?",
      body: "Point ADE at existing Git worktrees and they become Lanes instantly — no copying, no moving.",
      docUrl: `${DOCS}/lanes/creating`,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.stackPane"]',
      title: "Stack pane",
      body: "Start, stop, and watch the apps this Lane runs — dev server, tests, anything scripted.",
      docUrl: `${DOCS}/lanes/stacks`,
      placement: "right",
    },
    {
      target: '[data-tour="lanes.gitActionsPane"]',
      title: "Git, in plain words",
      body: "Commit, push, rebase — all explained. No command line required.",
      docUrl: `${DOCS}/lanes/overview`,
      placement: "right",
    },
    {
      target: '[data-tour="lanes.diffPane"]',
      title: "See what changed",
      body: "The Diff pane walks every change in this Lane, file by file. Red removed, green added.",
      docUrl: `${DOCS}/lanes/overview`,
      placement: "left",
    },
    {
      target: '[data-tour="lanes.workPane"]',
      title: "The Work pane",
      body: "Chat with a Worker, run a one-off command, or open a shell — all scoped to this Lane's worktree.",
      docUrl: `${DOCS}/chat/overview`,
      placement: "left",
    },
    {
      target: '[data-tour="app.helpMenu"]',
      title: "Help lives here",
      body: "The ? button holds every tour, the Glossary, and a link to the docs. Revisit it whenever you need a refresher.",
      docUrl: `${DOCS}/welcome`,
      placement: "bottom",
    },
  ],
};

registerTour(lanesTour);

export default lanesTour;
