import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

export const lanesTour: Tour = {
  id: "lanes",
  title: "Lanes walkthrough",
  route: "/lanes",
  steps: [
    {
      target: '[data-tour="lanes.branchSelector"]',
      title: "Your main branch",
      body: "This is the branch ADE treats as the clean starting point, usually `main`. New lanes start from the current primary branch, and ADE compares each lane back to its base so you can see what changed.",
      docUrl: docs.lanesOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.statusChips"]',
      title: "Filter by status",
      body: "Status chips answer, \"What needs attention right now?\" Running means work is active, waiting means a person or worker needs to decide, and ended means the lane is done or archived.",
      docUrl: docs.lanesOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.newLane"]',
      title: "Make a new lane",
      body: "Use this when you want a safe place for one task. Example: create `try-new-auth-flow`, let an agent edit there, and keep primary clean until you decide the work is worth shipping.",
      docUrl: docs.lanesCreating,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.laneTab"]',
      title: "Lane tabs",
      body: "Each tab is one lane, like one open workspace. Click tabs to switch tasks. Badges call out state such as uncommitted files, pinned lanes, or lanes that may need a rebase.",
      docUrl: docs.lanesOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.newLane"]',
      title: "Already have worktrees?",
      body: "The New Lane menu can also bring in work you already have. If a branch/worktree already exists, ADE can adopt it as a lane instead of making you recreate the work.",
      docUrl: docs.lanesCreating,
      placement: "bottom",
    },
    {
      target: '[data-tour="lanes.stackPane"]',
      title: "Stack pane",
      body: "Stacks explain dependency order. Example: `primary -> checkout-page -> checkout-errors` means the checkout-errors lane depends on checkout-page, so review and shipping should happen in that order.",
      docUrl: docs.lanesStacks,
      placement: "right",
    },
    {
      target: '[data-tour="lanes.gitActionsPane"]',
      title: "Git, in plain words",
      body: "This pane translates Git state into actions. Dirty files need a commit. A committed lane can push. A lane with new base commits may need a rebase. The buttons enable only when that action makes sense.",
      docUrl: docs.lanesOverview,
      placement: "right",
    },
    {
      target: '[data-tour="lanes.diffPane"]',
      title: "See what changed",
      body: "The Diff pane is the receipt for this lane. Red lines were removed, green lines were added, and each file shows exactly what this lane changed compared with its base.",
      docUrl: docs.lanesOverview,
      placement: "left",
    },
    {
      target: '[data-tour="lanes.workPane"]',
      title: "The Work pane",
      body: "This is where you ask for work inside this lane. A worker chat, CLI tool, or shell launched here edits and runs commands in this lane's folder, not in primary.",
      docUrl: docs.chatOverview,
      placement: "left",
    },
    {
      target: '[data-tour="app.helpMenu"]',
      title: "Help lives here",
      body: "The ? button can replay this Lanes walkthrough by itself later. Standalone walkthroughs explain the screen without asking you to create or delete anything.",
      docUrl: docs.welcome,
      placement: "bottom",
    },
  ],
};

registerTour(lanesTour);

export default lanesTour;
